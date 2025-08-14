// server.js (ESM)
// Requisitos: Node 18+ (fetch nativo), "type":"module" en package.json (si usas import)

import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

// ================== Config ==================
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.MODEL || 'gpt-4o-mini';
const DM_MODE = (process.env.DM_MODE || 'openai').toLowerCase(); // 'openai' | 'mock'
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '1500', 10);

const FALLBACK_MODELS = (process.env.FALLBACK_MODELS?.split(',') || [
  'gpt-4o-mini',
  'gpt-4o'
]).map(s => s.trim()).filter(Boolean);

// ================== App & IO ==================
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// ================== Estado en memoria ==================
/** roomId -> Map<socketId, { id, name }> */
const roomMembers = new Map();

/** roomId -> { system, messages: [{role,content}], lastAskAt, dmMode } */
const roomContexts = new Map();

/** roomId -> CombatState */
const combatStates = new Map();

// ================== Util presencia ==================
function getRoomMembers(roomId) {
  if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Map());
  return roomMembers.get(roomId);
}
function membersArray(roomId) {
  const m = roomMembers.get(roomId);
  return m ? Array.from(m.values()) : [];
}
function broadcastPresence(roomId) {
  io.to(roomId).emit('presence', membersArray(roomId)); // [{id,name}]
}

// ================== Prompt del DM ==================
function buildSystemPrompt() {
  return `Eres "The Dungeon Master", un DM experto de Dungeons & Dragons 5e.
- Mantén el tono inmersivo, describe con detalles sensoriales sin alargar en exceso.
- Sigue reglas 5e cuando corresponda; si falta info, pregunta con opciones.
- Da 3–5 opciones claras al final de cada turno.
- Cuando se pidan tiradas, indica tipo y DC sugerida (ej: Percepción DC 13).
- Evita metajuego y no mates gratuitamente a los PJ.
- Responde en español.

CUANDO CORRESPONDA, añade AL FINAL de tu mensaje UNA sola línea de control, exactamente con uno de estos comandos:
[CMD:START_COMBAT duration=60 auto=1 delay=1]
[CMD:REROLL]
[CMD:NEXT_TURN]
[CMD:PREV_TURN]
[CMD:END_COMBAT]
[CMD:PAUSE]
[CMD:RESUME]
[CMD:SETTINGS duration=45 auto=0 delay=0]
[CMD:SYNC_PLAYERS]
No inventes otros comandos y no añadas comillas alrededor de la línea CMD.`;
}

function getRoomContext(roomId) {
  if (!roomContexts.has(roomId)) {
    roomContexts.set(roomId, {
      system: buildSystemPrompt(),
      messages: [],
      lastAskAt: 0,
      dmMode: DM_MODE
    });
  }
  return roomContexts.get(roomId);
}

// ================== OpenAI helpers (vía fetch) ==================
function authHeaders() {
  const h = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };
  if (process.env.OPENAI_ORG) h['OpenAI-Organization'] = process.env.OPENAI_ORG;
  if (process.env.OPENAI_PROJECT) h['OpenAI-Project'] = process.env.OPENAI_PROJECT;
  return h;
}

async function callChatCompletions(model, messages) {
  const payload = { model, messages, temperature: 0.8, max_tokens: 450 };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { /* ignore parse error */ }

  if (!res.ok) {
    const err = new Error(data?.error?.message || text || `HTTP ${res.status}`);
    err.name = 'OpenAIApiError';
    err.status = res.status;
    err.code = data?.error?.code;
    err.type = data?.error?.type;
    throw err;
  }
  return data?.choices?.[0]?.message?.content?.trim() || '(sin respuesta)';
}

async function askOpenAIWithFallback(allMessages) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const candidates = [MODEL, ...FALLBACK_MODELS].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastErr;
  for (const m of candidates) {
    try {
      return await callChatCompletions(m, allMessages);
    } catch (e) {
      lastErr = e;
      const notFound = e?.status === 404 || e?.code === 'model_not_found';
      const insufficient = e?.status === 429 && (e?.code === 'insufficient_quota' || /quota/i.test(e?.message || ''));
      if (insufficient) throw e; // no hay cuota: salir
      if (!notFound) throw e;    // error distinto: salir
      console.warn(`[DM] Modelo no disponible: ${m} (${e?.code || e?.status}). Probando siguiente...`);
    }
  }
  throw lastErr;
}

// ================== Mock DM ==================
function mockDMReply(userText) {
  const hooks = [
    'El aire huele a humedad y madera vieja.',
    'Una brisa apaga por un segundo tu antorcha.',
    'Oyes un murmullo detrás de una pared de piedra.',
    'El suelo cruje como si algo se moviese debajo.'
  ];
  const options = [
    'Examinar más de cerca (Investigación DC 12).',
    'Avanzar con sigilo (Sigilo DC 13).',
    'Llamar a quien esté ahí.',
    'Preparar un arma y esperar.',
    'Retroceder y buscar otra ruta.'
  ];
  const hook = hooks[Math.floor(Math.random() * hooks.length)];
  const shuffled = options.sort(() => Math.random() - 0.5).slice(0, 4);
  return [
    `Tomas una decisión tras decir: "${userText}".`,
    hook,
    '',
    '¿Qué haces ahora? Opciones:',
    ...shuffled.map((o, i) => `${i + 1}) ${o}`)
  ].join('\n');
}

// ================== Lógica principal DM ==================
async function askDM(roomId, userMessage) {
  const ctx = getRoomContext(roomId);

  // Antispam simple por sala
  const now = Date.now();
  if (now - ctx.lastAskAt < RATE_LIMIT_MS) {
    return '⏳ Espera un poco antes de volver a preguntar al DM.';
  }
  ctx.lastAskAt = now;

  // Guarda mensaje de usuario
  ctx.messages.push({ role: 'user', content: userMessage });

  // Modo mock forzado o sin API key
  if (ctx.dmMode === 'mock' || DM_MODE === 'mock' || !OPENAI_API_KEY) {
    const mock = mockDMReply(userMessage);
    ctx.messages.push({ role: 'assistant', content: mock });
    if (ctx.messages.length > 40) ctx.messages.splice(0, 10);
    return mock;
  }

  // Intento con OpenAI
  const allMessages = [{ role: 'system', content: ctx.system }, ...ctx.messages];

  try {
    const reply = await askOpenAIWithFallback(allMessages);
    ctx.messages.push({ role: 'assistant', content: reply });
    if (ctx.messages.length > 40) ctx.messages.splice(0, 10);
    return reply;
  } catch (err) {
    console.error('[DM] Error OpenAI:', err);
    const insufficient = err?.status === 429 && (err?.code === 'insufficient_quota' || /quota/i.test(err?.message || ''));
    if (insufficient) {
      // Cambiamos a mock para esta sala y avisamos
      ctx.dmMode = 'mock';
      const reply = [
        '⚠️ OpenAI sin cuota en este momento. Cambio automático a DM local.',
        '',
        mockDMReply(userMessage)
      ].join('\n');
      ctx.messages.push({ role: 'assistant', content: reply });
      return reply;
    }
    // Otros errores: informar sin cambiar modo
    return `⚠️ Error del modelo: ${err?.message || err?.code || err?.status || 'desconocido'}`;
  }
}

// ================== API REST opcional ==================
app.post('/api/dm', async (req, res) => {
  const { roomId = 'default', message = '' } = req.body || {};
  const reply = await askDM(roomId, message);
  // Ejecuta comandos si vinieran en la respuesta
  handleDMCommands(io, roomId, reply);
  res.json({ reply });
});

app.get('/api/rooms/:roomId/context', (req, res) => {
  const ctx = getRoomContext(req.params.roomId);
  res.json({ size: ctx.messages.length, dmMode: ctx.dmMode });
});

app.get('/api/health', (_req, res) => {
  res.json({
    model: MODEL,
    dmModeDefault: DM_MODE,
    fallbacks: FALLBACK_MODELS,
    rateLimitMs: RATE_LIMIT_MS
  });
});

// ================== Combate ==================
function publicCombatState(st) {
  const { _timer, ...pub } = st;
  return { ...pub, serverNow: Date.now() };
}

function scheduleAdvance(io, roomId) {
  const st = combatStates.get(roomId);
  if (!st) return;
  clearTimeout(st._timer);
  st._timer = null;

  if (!st.running || !st.autoAdvance) return;

  const now = Date.now();
  const ms = Math.max(0, st.endAt - now) + Math.max(0, (st.autoDelaySec ?? 0) * 1000);
  st._timer = setTimeout(() => {
    const next = st.turnIndex + 1;
    if (next >= st.list.length) {
      st.turnIndex = 0;
      st.round += 1;
      io.to(roomId).emit('system', `🌀 **Ronda ${st.round}** — turno de **${st.list[0]?.name ?? '—'}**`);
    } else {
      st.turnIndex = next;
    }
    st.endAt = Date.now() + st.durationSec * 1000;
    combatStates.set(roomId, st);
    io.to(roomId).emit('combat:update', publicCombatState(st));
    scheduleAdvance(io, roomId);
  }, ms);
}

function startCombat(io, roomId, opts = {}) {
  const players = membersArray(roomId);
  if (!players.length) return null;

  const list = players.map(p => ({
    id: p.id,
    name: p.name,
    init: 1 + Math.floor(Math.random() * 20)
  })).sort((a, b) => b.init - a.init || a.name.localeCompare(b.name));

  const st = {
    roomId,
    list,
    round: 1,
    turnIndex: 0,
    durationSec: Math.max(10, Math.min(600, Number(opts.durationSec) || 60)),
    autoAdvance: typeof opts.autoAdvance === 'boolean' ? opts.autoAdvance : true,
    autoDelaySec: Math.max(0, Math.min(10, Number(opts.autoDelaySec) || 1)),
    running: true,
    endAt: Date.now() + (Number(opts.durationSec) || 60) * 1000,
    _timer: null
  };
  combatStates.set(roomId, st);

  const lines = st.list.map((e, i) => `${i + 1}) **${e.name}** — ${e.init}`).join('\n');
  io.to(roomId).emit('system', `🛡️ **Orden de iniciativa — Inicial**\n${lines}`);
  io.to(roomId).emit('combat:update', publicCombatState(st));
  scheduleAdvance(io, roomId);
  return st;
}
function rerollCombat(io, roomId) {
  const st = combatStates.get(roomId);
  if (!st) return startCombat(io, roomId, {});
  st.list = st.list
    .map(e => ({ ...e, init: 1 + Math.floor(Math.random() * 20) }))
    .sort((a, b) => b.init - a.init || a.name.localeCompare(b.name));
  st.round = 1;
  st.turnIndex = 0;
  st.endAt = Date.now() + st.durationSec * 1000;
  st.running = true;
  combatStates.set(roomId, st);
  const lines = st.list.map((e, i) => `${i + 1}) **${e.name}** — ${e.init}`).join('\n');
  io.to(roomId).emit('system', `🛡️ **Orden de iniciativa — Re-tirada**\n${lines}`);
  io.to(roomId).emit('combat:update', publicCombatState(st));
  scheduleAdvance(io, roomId);
}
function nextTurn(io, roomId) {
  const st = combatStates.get(roomId);
  if (!st || !st.list.length) return;
  const next = st.turnIndex + 1;
  if (next >= st.list.length) {
    st.turnIndex = 0;
    st.round += 1;
    io.to(roomId).emit('system', `🌀 **Ronda ${st.round}** — turno de **${st.list[0]?.name ?? '—'}**`);
  } else {
    st.turnIndex = next;
  }
  st.endAt = Date.now() + st.durationSec * 1000;
  st.running = true;
  combatStates.set(roomId, st);
  io.to(roomId).emit('combat:update', publicCombatState(st));
  scheduleAdvance(io, roomId);
}
function prevTurn(io, roomId) {
  const st = combatStates.get(roomId);
  if (!st || !st.list.length) return;
  st.turnIndex = (st.turnIndex - 1 + st.list.length) % st.list.length;
  st.endAt = Date.now() + st.durationSec * 1000;
  st.running = true;
  combatStates.set(roomId, st);
  io.to(roomId).emit('combat:update', publicCombatState(st));
  scheduleAdvance(io, roomId);
}
function endCombat(io, roomId) {
  const st = combatStates.get(roomId);
  if (st) clearTimeout(st._timer);
  combatStates.delete(roomId);
  io.to(roomId).emit('system', '🏁 **El combate ha terminado.**');
  io.to(roomId).emit('combat:update', {
    roomId,
    list: [],
    round: 1,
    turnIndex: 0,
    running: false,
    serverNow: Date.now()
  });
}
function applySettings(io, roomId, opts) {
  const st = combatStates.get(roomId);
  if (!st) return;
  if (typeof opts.durationSec === 'number' && opts.durationSec > 0)
    st.durationSec = Math.max(10, Math.min(600, Math.round(opts.durationSec)));
  if (typeof opts.autoAdvance === 'boolean') st.autoAdvance = opts.autoAdvance;
  if (typeof opts.autoDelaySec === 'number')
    st.autoDelaySec = Math.max(0, Math.min(10, Math.round(opts.autoDelaySec)));
  if (st.running) st.endAt = Date.now() + st.durationSec * 1000;
  combatStates.set(roomId, st);
  io.to(roomId).emit('combat:update', publicCombatState(st));
  scheduleAdvance(io, roomId);
}
function syncPlayers(io, roomId) {
  const st = combatStates.get(roomId);
  if (!st) return;
  const ids = new Set(st.list.map(e => e.id));
  const newcomers = membersArray(roomId).filter(p => !ids.has(p.id));
  if (newcomers.length) {
    st.list.push(...newcomers.map(p => ({ id: p.id, name: p.name, init: 0 })));
    combatStates.set(roomId, st);
    io.to(roomId).emit('combat:update', publicCombatState(st));
    io.to(roomId).emit('system', `➕ Añadidos: ${newcomers.map(n => n.name).join(', ')}`);
  }
}

// ================== Parser comandos DM ==================
function parseKv(str) {
  const out = {};
  (str || '').trim().split(/\s+/).forEach(tok => {
    const m = tok.match(/^([a-zA-Z_]+)=(.+)$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  });
  return out;
}
function handleDMCommands(io, roomId, text) {
  const re = /\[CMD:([A-Z_]+)([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const cmd = m[1];
    const kv = parseKv(m[2] || '');
    switch (cmd) {
      case 'START_COMBAT':
        startCombat(io, roomId, {
          durationSec: Number(kv.duration ?? kv.duracion ?? 60),
          autoAdvance: ['1', 'true', 'si', 'sí'].includes(String(kv.auto ?? '1').toLowerCase()),
          autoDelaySec: Number(kv.delay ?? 1)
        });
        break;
      case 'REROLL':      rerollCombat(io, roomId); break;
      case 'NEXT_TURN':   nextTurn(io, roomId);     break;
      case 'PREV_TURN':   prevTurn(io, roomId);     break;
      case 'END_COMBAT':  endCombat(io, roomId);    break;
      case 'PAUSE': {
        const st = combatStates.get(roomId);
        if (st) { st.running = false; clearTimeout(st._timer); io.to(roomId).emit('combat:update', publicCombatState(st)); }
        break;
      }
      case 'RESUME': {
        const st = combatStates.get(roomId);
        if (st) { st.running = true; st.endAt = Date.now() + (st.durationSec * 1000); io.to(roomId).emit('combat:update', publicCombatState(st)); scheduleAdvance(io, roomId); }
        break;
      }
      case 'SETTINGS':
        applySettings(io, roomId, {
          durationSec: kv.duration ? Number(kv.duration) : undefined,
          autoAdvance: kv.auto != null ? ['1','true','si','sí'].includes(String(kv.auto).toLowerCase()) : undefined,
          autoDelaySec: kv.delay != null ? Number(kv.delay) : undefined
        });
        break;
      case 'SYNC_PLAYERS': syncPlayers(io, roomId); break;
      default: break;
    }
  }
}

// ================== Detección de comandos implícitos (@dm ...) ==================
function stripDiacritics(s) {
  try { return s.normalize('NFD').replace(/\p{Diacritic}/gu, ''); } catch { return s; }
}
function detectImplicitCmd(userText) {
  const t = stripDiacritics((userText || '').toLowerCase());
  // START
  if (/(inicia(r)?|empieza(r)?|empezamos|comenzar|comienza).*(combate|encuentro)|^start\b.*(combat|encounter)/.test(t))
    return { cmd: 'START_COMBAT' };
  // REROLL
  if (/(re[-\s]?tirar|re[-\s]?tira|re[-\s]?tiramos|reroll|reordenar).*(iniciativa|orden)?/.test(t))
    return { cmd: 'REROLL' };
  // NEXT
  if (/(siguiente|avanza|pasa|proximo|turno siguiente)/.test(t))
    return { cmd: 'NEXT_TURN' };
  // PREV
  if (/(anterior|retrocede|vuelve atras)/.test(t))
    return { cmd: 'PREV_TURN' };
  // END
  if (/(termina(r)?|fin|acaba(r)?)\s*(el)?\s*(combate|encuentro)/.test(t))
    return { cmd: 'END_COMBAT' };
  // PAUSE
  if (/(pausa|pausar|deten|stop)\b/.test(t))
    return { cmd: 'PAUSE' };
  // RESUME
  if (/(reanuda|resume|continuar|seguir|play)\b/.test(t))
    return { cmd: 'RESUME' };
  // SETTINGS (duración/retardo/auto)
  const mDur = t.match(/\b(duracion|duration)\s*(=|:)?\s*(\d{1,3})\b/);
  const mDel = t.match(/\b(retardo|delay)\s*(=|:)?\s*(\d{1,2})\b/);
  const mAut = t.match(/\b(auto|automatico|autoavance)\s*(=|:)?\s*(si|sí|no|true|false|1|0)\b/);
  if (mDur || mDel || mAut) {
    return {
      cmd: 'SETTINGS',
      opts: {
        durationSec: mDur ? Number(mDur[3]) : undefined,
        autoDelaySec: mDel ? Number(mDel[3]) : undefined,
        autoAdvance: mAut ? ['si','sí','true','1'].includes(mAut[3]) : undefined
      }
    };
  }
  return null;
}

// ================== Socket.IO ==================
io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname = `Jugador-${socket.id.slice(0, 4)}`;

  function joinRoom(roomId, name) {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = roomId || 'default';
    if (name && typeof name === 'string') nickname = name.trim().slice(0, 40);

    socket.join(currentRoom);
    socket.emit('joined', { roomId: currentRoom, nickname });

    const members = getRoomMembers(currentRoom);
    members.set(socket.id, { id: socket.id, name: nickname });
    broadcastPresence(currentRoom);

    socket.to(currentRoom).emit('system', `${nickname} se ha unido a la mesa.`);

    // Estado de combate actual
    const st = combatStates.get(currentRoom);
    if (st) socket.emit('combat:update', publicCombatState(st));
  }

  // Elimina líneas/fragmentos [CMD:...] de un texto
function stripCmdLines(s = '') {
  if (!s) return s;
  // 1) quita líneas completas con solo el CMD
  let out = s.split(/\r?\n/).filter(line => !/^\s*\[CMD:[^\]]+\]\s*$/i.test(line)).join('\n');
  // 2) por si aparece inline, elimina el token
  out = out.replace(/\s*\[CMD:[^\]]+\]\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  return out;
}


  // Presencia
  socket.on('join', ({ roomId, name }) => joinRoom(roomId, name));
  socket.on('getPresence', () => { if (currentRoom) broadcastPresence(currentRoom); });

  // Chat + IA DM + comandos
  socket.on('chat', async ({ text, dm = false }) => {
    if (!currentRoom) return;
    const payload = { from: nickname, text, ts: Date.now() };
    io.to(currentRoom).emit('chat', payload);
  
    if (dm || /^@dm\b/i.test(text)) {
      const userText = text.replace(/^@dm\b/i, '').trim();
  
      // 1) INTENTO INMEDIATO: detectar comando implícito
      const implicit = detectImplicitCmd(userText);
      let ranImplicit = false;
      if (implicit) {
        ranImplicit = true;
        switch (implicit.cmd) {
          case 'START_COMBAT': startCombat(io, currentRoom, {}); break;
          case 'REROLL':       rerollCombat(io, currentRoom);    break;
          case 'NEXT_TURN':    nextTurn(io, currentRoom);        break;
          case 'PREV_TURN':    prevTurn(io, currentRoom);        break;
          case 'END_COMBAT':   endCombat(io, currentRoom);       break;
          case 'PAUSE': {
            const st = combatStates.get(currentRoom);
            if (st) { st.running = false; clearTimeout(st._timer); io.to(currentRoom).emit('combat:update', publicCombatState(st)); }
            break;
          }
          case 'RESUME': {
            const st = combatStates.get(currentRoom);
            if (st) { st.running = true; st.endAt = Date.now() + st.durationSec * 1000; io.to(currentRoom).emit('combat:update', publicCombatState(st)); scheduleAdvance(io, currentRoom); }
            break;
          }
          case 'SETTINGS':     applySettings(io, currentRoom, implicit.opts || {}); break;
        }
        // 👇 QUITAMOS este aviso para no “mostrar” comandos en el chat
        // io.to(currentRoom).emit('system', `🤖 DM: orden recibida (${implicit.cmd.replace('_',' ')})`);
      }
  
      // 2) Pide narrativa a la IA
      const replyRaw = await askDM(currentRoom, userText || text);
      // 3) Ejecuta comandos que vengan en la respuesta
      handleDMCommands(io, currentRoom, replyRaw);
      // 4) Limpia los [CMD:...] antes de mostrar
      const reply = stripCmdLines(replyRaw);
      if (reply.trim()) {
        io.to(currentRoom).emit('dm', { from: 'DM', text: reply, ts: Date.now() });
      }
    }
  });
  

  // Tiradas
  socket.on('roll', ({ notation }) => {
    if (!currentRoom) return;
    const result = rollDice(notation);
    if (!result.ok) { socket.emit('system', `🎲 Error: ${result.error}`); return; }
    const { rolls, mod, total, faces, count } = result;
    io.to(currentRoom).emit('roll', {
      from: nickname,
      notation,
      detail: `${count}d${faces}${mod >= 0 ? `+${mod}` : mod}`,
      rolls,
      total,
      ts: Date.now()
    });
  });

  // Anuncios manuales
  socket.on('announce', (payload) => {
    if (!currentRoom) return;
    const text = (typeof payload === 'string' ? payload : payload?.text) || '';
    if (!text.trim()) return;
    io.to(currentRoom).emit('system', text.toString().slice(0, 2000));
  });

  // Los eventos de combate desde cliente NO se atienden (solo IA)
  [
    'combat:start','combat:reroll','combat:next','combat:prev',
    'combat:end','combat:syncPlayers','combat:settings','combat:pause','combat:resume'
  ].forEach(evt => socket.on(evt, () => socket.emit('system', '⛔ Solo el DM (IA) controla el combate.')));

  // Estado actual de combate
  socket.on('combat:get', () => {
    if (!currentRoom) return;
    const st = combatStates.get(currentRoom);
    socket.emit('combat:update', st ? publicCombatState(st) : {
      roomId: currentRoom, list: [], round: 1, turnIndex: 0, running: false, serverNow: Date.now()
    });
  });

  // Desconexión
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const mem = getRoomMembers(currentRoom);
    mem.delete(socket.id);
    broadcastPresence(currentRoom);
    socket.to(currentRoom).emit('system', `${nickname} ha salido de la mesa.`);
  });
});

// ================== Dados ==================
function rollDice(notation = '1d20+0') {
  const m = (notation || '').toLowerCase().match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!m) return { ok: false, error: 'Notación inválida. Usa p.ej. 1d20+5' };
  const count = parseInt(m[1], 10);
  const faces = parseInt(m[2], 10);
  const mod = parseInt(m[3] || '0', 10);
  if (count <= 0 || faces <= 1) return { ok: false, error: 'Dados inválidos.' };
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * faces));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  return { ok: true, rolls, mod, total, faces, count };
}

// ================== Arranque ==================
httpServer.listen(PORT, () => {
  console.log(`D&D DM server escuchando en http://localhost:${PORT}`);
});

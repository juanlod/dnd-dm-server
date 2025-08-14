import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o-mini';
const DM_MODE = (process.env.DM_MODE || 'openai').toLowerCase(); // 'openai' | 'mock'
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '1500', 10);

// Lista de modelos alternativos (por si el principal no existe)
const FALLBACK_MODELS = (process.env.FALLBACK_MODELS?.split(',') || [
  'gpt-4o-mini',
  'gpt-4o'
]).map(s => s.trim()).filter(Boolean);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// ---- Estado por sala ----
const roomContexts = new Map(); // roomId -> { system, messages: [], lastAskAt: number, dmMode: 'openai'|'mock' }
function getRoomContext(roomId) {
  if (!roomContexts.has(roomId)) {
    roomContexts.set(roomId, {
      system: buildSystemPrompt(),
      messages: [],
      lastAskAt: 0,
      dmMode: DM_MODE // inicia según .env
    });
  }
  return roomContexts.get(roomId);
}

function buildSystemPrompt() {
  return `Eres "The Dungeon Master", un DM experto de Dungeons & Dragons 5e.
- Mantén el tono inmersivo, describe con detalles sensoriales sin alargar en exceso.
- Sigue reglas 5e cuando corresponda; si falta info, pregunta con opciones.
- Da 3–5 opciones claras al final de cada turno.
- Cuando se pidan tiradas, indica tipo y DC sugerida (ej: Percepción DC 13).
- Evita metajuego y no mates gratuitamente a los PJ.
- Responde en español.`;
}

// ---- OpenAI helpers ----
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
  const payload = { model, messages, temperature: 0.8, max_tokens: 450 }; // baja tokens para ahorrar
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
  const candidates = [MODEL, ...FALLBACK_MODELS].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastErr;
  for (const m of candidates) {
    try {
      return await callChatCompletions(m, allMessages);
    } catch (e) {
      lastErr = e;
      const notFound = e?.status === 404 || e?.code === 'model_not_found';
      const insufficient = e?.status === 429 && (e?.code === 'insufficient_quota' || /quota/i.test(e?.message || ''));
      if (insufficient) throw e; // cuota agotada: no sirve seguir probando
      if (!notFound) throw e;    // otros errores: salir
      console.warn(`[DM] Modelo no disponible: ${m} (${e?.code || e?.status}). Probando siguiente...`);
    }
  }
  throw lastErr;
}

// ---- Mock DM (fallback local) ----
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

// ---- Lógica principal DM ----
async function askDM(roomId, userMessage) {
  const ctx = getRoomContext(roomId);

  // Antispam por sala
  const now = Date.now();
  if (now - ctx.lastAskAt < RATE_LIMIT_MS) {
    return '⏳ Espera un poco antes de volver a preguntar al DM.';
  }
  ctx.lastAskAt = now;

  // Guarda mensaje de usuario
  ctx.messages.push({ role: 'user', content: userMessage });

  // Si estamos en modo mock forzado, no llamamos a OpenAI
  if (ctx.dmMode === 'mock' || DM_MODE === 'mock') {
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

// ---- API REST ----
app.post('/api/dm', async (req, res) => {
  const { roomId = 'default', message = '' } = req.body || {};
  const reply = await askDM(roomId, message);
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

// ---- WebSockets ----
io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname = `Jugador-${socket.id.slice(0, 4)}`;

  socket.on('join', ({ roomId, name }) => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = roomId || 'default';
    if (name && typeof name === 'string') nickname = name;
    socket.join(currentRoom);
    socket.emit('joined', { roomId: currentRoom, nickname });
    socket.to(currentRoom).emit('system', `${nickname} se ha unido a la mesa.`);
  });

  socket.on('chat', async ({ text, dm = false }) => {
    if (!currentRoom) return;
    const payload = { from: nickname, text, ts: Date.now() };
    io.to(currentRoom).emit('chat', payload);

    if (dm || /^@dm\b/i.test(text)) {
      const userText = text.replace(/^@dm\b/i, '').trim();
      const reply = await askDM(currentRoom, userText || text);
      io.to(currentRoom).emit('dm', { from: 'DM', text: reply, ts: Date.now() });
    }
  });

  socket.on('roll', ({ notation }) => {
    if (!currentRoom) return;
    const result = rollDice(notation);
    if (!result.ok) {
      socket.emit('system', `🎲 Error: ${result.error}`);
      return;
    }
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

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('system', `${nickname} ha salido de la mesa.`);
    }
  });
});

// ---- Dados ----
function rollDice(notation = '1d20+0') {
  const m = notation.toLowerCase().match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!m) return { ok: false, error: 'Notación inválida. Usa p.ej. 1d20+5' };
  const count = parseInt(m[1], 10);
  const faces = parseInt(m[2], 10);
  const mod = parseInt(m[3] || '0', 10);
  if (count <= 0 || faces <= 1) return { ok: false, error: 'Dados inválidos.' };
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * faces));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  return { ok: true, rolls, mod, total, faces, count };
}

httpServer.listen(PORT, () => {
  console.log(`D&D DM server escuchando en http://localhost:${PORT}`);
});

import { roomChars, partySynthTimers } from './state.js';
import { askOpenAIWithFallback } from './openai.js';
import { getRoomContext } from './room-context.js'; // ver archivo abajo

/** Map interno de fichas por sala */
export function getRoomCharsMap(roomId) {
  if (!roomChars.has(roomId)) roomChars.set(roomId, new Map());
  return roomChars.get(roomId);
}

export function partyContextText(roomId) {
  const map = roomChars.get(roomId);
  if (!map || map.size === 0) return 'No hay fichas compartidas en esta sala.';
  const lines = [];
  for (const { name, sheet } of map.values()) {
    if (!sheet) continue;
    const pj = sheet.name || name || 'PJ';
    const lvl = sheet.level ?? 1;
    const clazz = sheet.clazz || 'Clase ?';
    const ac = sheet.ac ?? 10;
    const hpCur = sheet.hp ?? sheet.maxHp ?? 0;
    const hpMax = sheet.maxHp ?? 0;
    const pp = sheet.senses?.passivePerception ?? 10;
    const speed = sheet.speed ?? 30;
    lines.push(`- ${pj} — ${clazz} ${lvl} • CA ${ac} • HP ${hpCur}/${hpMax} • PP ${pp} • Vel ${speed}`);
  }
  return `Contexto del grupo:\n${lines.join('\n')}`;
}

/** Debounce + síntesis automática (mensaje del “DM”) */
export function schedulePartySynthesis(io, roomId, delayMs = 1600) {
  const prev = partySynthTimers.get(roomId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => { doPartySynthesis(io, roomId).catch(console.error); }, delayMs);
  partySynthTimers.set(roomId, t);
}

export async function doPartySynthesis(io, roomId) {
  const summary = partyContextText(roomId);
  if (!summary || /No hay fichas/i.test(summary)) return;

  const ctx = getRoomContext(roomId);
  const msgs = [
    { role: 'system', content: ctx.system },
    { role: 'system', content: summary },
    { role: 'user', content: 'Sistema de mesa: fichas añadidas/actualizadas. Sintetiza el grupo en 1–2 frases y sugiere un siguiente paso. NO añadas [CMD:...]' }
  ];

  let reply = '📘 He actualizado mentalmente el estado del grupo.';
  try {
    reply = await askOpenAIWithFallback(msgs);
  } catch (e) {
    console.error('[DM] Error OpenAI (synthesis):', e);
  }
  if (reply?.trim()) io.to(roomId).emit('dm', { from: 'DM', text: reply, ts: Date.now() });
}

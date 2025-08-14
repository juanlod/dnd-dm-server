import { combatStates } from './state.js';
import { membersArray } from './state.js';
import { DEFAULT_TURN_SEC } from './config.js';

export function publicCombatState(st) {
  const { _timer, ...pub } = st;
  return { ...pub, serverNow: Date.now() };
}

export function scheduleAdvance(io, roomId) {
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

export function startCombat(io, roomId, opts = {}) {
  const players = membersArray(roomId);
  if (!players.length) return null;

  const list = players.map(p => ({
    id: p.id,
    name: p.name,
    init: 1 + Math.floor(Math.random() * 20)
  })).sort((a, b) => b.init - a.init || a.name.localeCompare(b.name));

  const dur = Math.max(10, Math.min(3600, Number(opts.durationSec) || DEFAULT_TURN_SEC));

  const st = {
    roomId,
    list,
    round: 1,
    turnIndex: 0,
    durationSec: dur,
    autoAdvance: typeof opts.autoAdvance === 'boolean' ? opts.autoAdvance : true,
    autoDelaySec: Math.max(0, Math.min(10, Number(opts.autoDelaySec) || 1)),
    running: true,
    endAt: Date.now() + dur * 1000,
    _timer: null
  };
  combatStates.set(roomId, st);

  const lines = st.list.map((e, i) => `${i + 1}) **${e.name}** — ${e.init}`).join('\n');
  io.to(roomId).emit('system', `🛡️ **Orden de iniciativa — Inicial**\n${lines}`);
  io.to(roomId).emit('combat:update', publicCombatState(st));
  scheduleAdvance(io, roomId);
  return st;
}

export function rerollCombat(io, roomId) {
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

export function nextTurn(io, roomId) {
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

export function prevTurn(io, roomId) {
  const st = combatStates.get(roomId);
  if (!st || !st.list.length) return;
  st.turnIndex = (st.turnIndex - 1 + st.list.length) % st.list.length;
  st.endAt = Date.now() + st.durationSec * 1000;
  st.running = true;
  combatStates.set(roomId, st);
  io.to(roomId).emit('combat:update', publicCombatState(st));
  scheduleAdvance(io, roomId);
}

export function endCombat(io, roomId) {
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

export function applySettings(io, roomId, opts) {
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

export function syncPlayers(io, roomId) {
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

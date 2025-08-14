import { startCombat, rerollCombat, nextTurn, prevTurn, endCombat, applySettings, syncPlayers } from './combat.js';

function parseKv(str) {
  const out = {};
  (str || '').trim().split(/\s+/).forEach(tok => {
    const m = tok.match(/^([a-zA-Z_]+)=(.+)$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  });
  return out;
}

export function handleDMCommands(io, roomId, text) {
  const re = /\[CMD:([A-Z_]+)([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const cmd = m[1];
    const kv = parseKv(m[2] || '');

    switch (cmd) {
      case 'START_COMBAT': {
        const raw = (kv.duration ?? kv.duracion);
        const durationSec = raw != null && raw !== '' ? Number(raw) : undefined;
        startCombat(io, roomId, {
          durationSec,
          autoAdvance: ['1', 'true', 'si', 'sí'].includes(String(kv.auto ?? '1').toLowerCase()),
          autoDelaySec: Number(kv.delay ?? 1)
        });
        break;
      }
      case 'REROLL': rerollCombat(io, roomId); break;
      case 'NEXT_TURN': nextTurn(io, roomId); break;
      case 'PREV_TURN': prevTurn(io, roomId); break;
      case 'END_COMBAT': endCombat(io, roomId); break;
      case 'PAUSE': {
        // pausa “soft”
        break;
      }
      case 'RESUME': {
        // resume “soft”
        break;
      }
      case 'SETTINGS': {
        const rawDur = kv.duration ?? kv.duracion;
        applySettings(io, roomId, {
          durationSec: rawDur != null && rawDur !== '' ? Number(rawDur) : undefined,
          autoAdvance: kv.auto != null ? ['1', 'true', 'si', 'sí'].includes(String(kv.auto).toLowerCase()) : undefined,
          autoDelaySec: kv.delay != null ? Number(kv.delay) : undefined
        });
        break;
      }
      case 'SYNC_PLAYERS': syncPlayers(io, roomId); break;
      default: break;
    }
  }
}
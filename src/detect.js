import { combatStates } from './state.js';
import { stripDiacritics } from './utils.js';
import { startCombat } from './combat.js';

export function inCombat(roomId) {
  const st = combatStates.get(roomId);
  return !!(st && st.list && st.list.length);
}

export function detectImplicitCmd(userText) {
  const t = stripDiacritics((userText || '').toLowerCase());
  if (/(inicia(r)?|empieza(r)?|empezamos|comenzar|comienza).*(combate|encuentro)|^start\b.*(combat|encounter)/.test(t))
    return { cmd: 'START_COMBAT' };
  if (/(re[-\s]?tirar|re[-\s]?tira|re[-\s]?tiramos|reroll|reordenar).*(iniciativa|orden)?/.test(t))
    return { cmd: 'REROLL' };
  if (/(siguiente|avanza|pasa|proximo|turno siguiente)/.test(t))
    return { cmd: 'NEXT_TURN' };
  if (/(anterior|retrocede|vuelve atras)/.test(t))
    return { cmd: 'PREV_TURN' };
  if (/(termina(r)?|fin|acaba(r)?)\s*(el)?\s*(combate|encuentro)/.test(t))
    return { cmd: 'END_COMBAT' };
  if (/(pausa|pausar|deten|stop)\b/.test(t))
    return { cmd: 'PAUSE' };
  if (/(reanuda|resume|continuar|seguir|play)\b/.test(t))
    return { cmd: 'RESUME' };
  const mDur = t.match(/\b(duracion|duration)\s*(=|:)?\s*(\d{1,3})\b/);
  const mDel = t.match(/\b(retardo|delay)\s*(=|:)?\s*(\d{1,2})\b/);
  const mAut = t.match(/\b(auto|automatico|autoavance)\s*(=|:)?\s*(si|sí|no|true|false|1|0)\b/);
  if (mDur || mDel || mAut) {
    return {
      cmd: 'SETTINGS',
      opts: {
        durationSec: mDur ? Number(mDur[3]) : undefined,
        autoDelaySec: mDel ? Number(mDel[3]) : undefined,
        autoAdvance: mAut ? ['si', 'sí', 'true', '1'].includes(mAut[3]) : undefined
      }
    };
  }
  return null;
}

// Heurística para detectar encuentro hostil por narrativa
export function looksLikeHostileEncounter(text = '') {
  const t = stripDiacritics(String(text).toLowerCase());
  const verbs = /(atac|embosc|arremet|abalanz|hostil|pelea|combate|iniciativa|iniciad|iniciar combate|turno)/;
  const creatures = /(goblin|trasgo|orco|ogro|troll|trol|bandid|esquelet|zombi|zombie|lobo|arañ|mimic|mímic|drag|gnoll|kobold|ogre|sucub|súcub|diabl|demon|espectr|ghoul|bestia)/;
  return verbs.test(t) && (creatures.test(t) || /iniciativa/.test(t));
}

export function maybeAutoStartCombat(io, roomId, text) {
  if (inCombat(roomId)) return;
  if (looksLikeHostileEncounter(text)) {
    startCombat(io, roomId, {});
    io.to(roomId).emit('system', '⚔️ Encuentro hostil detectado: iniciando combate.');
  }
}

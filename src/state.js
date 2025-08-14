// Estado en memoria por sala
export const roomMembers = new Map();   // roomId -> Map<socketId,{id,name}>
export const roomContexts = new Map();  // roomId -> { system, messages, lastAskAt, dmMode }
export const combatStates = new Map();  // roomId -> CombatState
export const roomChars = new Map();     // roomId -> Map<socketId,{id,name,sheet}>
export const partySynthTimers = new Map(); // roomId -> Timeout

export function getRoomMembers(roomId) {
  if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Map());
  return roomMembers.get(roomId);
}
export function membersArray(roomId) {
  const m = roomMembers.get(roomId);
  return m ? Array.from(m.values()) : [];
}

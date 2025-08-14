import { roomContexts } from './state.js';
import { DM_MODE } from './config.js';
import { buildSystemPrompt } from './prompt.js';

export function getRoomContext(roomId) {
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

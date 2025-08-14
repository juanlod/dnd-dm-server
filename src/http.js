import express from 'express';
import cors from 'cors';
import { askDM } from './dm.js';
import { handleDMCommands } from './commands.js';
import { MODEL, DM_MODE, RATE_LIMIT_MS } from './config.js';
import { getRoomContext } from './room-context.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // REST: /api/dm
  app.post('/api/dm', async (req, res) => {
    const { roomId = 'default', message = '' } = req.body || {};
    const reply = await askDM(roomId, message);
    handleDMCommands(req.io, roomId, reply); // inyectamos io en app (ver index.js)
    res.json({ reply });
  });

  // Estado básico del contexto
  app.get('/api/rooms/:roomId/context', (req, res) => {
    const ctx = getRoomContext(req.params.roomId);
    res.json({ size: ctx.messages.length, dmMode: ctx.dmMode });
  });

  // Health
  app.get('/api/health', (_req, res) => {
    res.json({ model: MODEL, dmModeDefault: DM_MODE, rateLimitMs: RATE_LIMIT_MS });
  });

  return app;
}

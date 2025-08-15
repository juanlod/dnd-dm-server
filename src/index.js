import 'dotenv/config';
import { createServer } from 'http';
import { createApp } from './http.js';
import { attachSocket } from './socket.js';

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const app = createApp({
  // si tu createApp acepta opciones, puedes pasar CORS aquí también
});

// ✔️ health checks para Render
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.head('/healthz', (_req, res) => res.status(200).end());

// Creamos HTTP server y montamos Socket.IO
const httpServer = createServer(app);
const io = attachSocket(httpServer, CLIENT_ORIGINS.length ? CLIENT_ORIGINS : '*');

// ✔️ inyecta io a TODAS las rutas (para usar req.io en /api/dm)
app.use((req, _res, next) => { req.io = io; next(); });

// (Opcional) evitar 404 ruidoso de / y /favicon.ico
app.get('/', (_req, res) => res.type('text/plain').send('D&D DM server up'));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`D&D DM server escuchando en :${PORT}`);
});

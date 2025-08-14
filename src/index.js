import 'dotenv/config';
import { createServer } from 'http';
import { createApp } from './http.js';
import { attachSocket } from './socket.js';
import { PORT } from './config.js';

const app = createApp();

// Inyecta io en las rutas REST (para handleDMCommands después de /api/dm)
app.use((req, _res, next) => {
  req.io = io; // eslint-disable-line no-undef
  next();
});

const httpServer = createServer(app);
const io = attachSocket(httpServer, '*'); // CORS abierto; ajusta según necesites

httpServer.listen(PORT, () => {
  console.log(`D&D DM server escuchando en http://localhost:${PORT}`);
});

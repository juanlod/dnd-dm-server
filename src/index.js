import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = http.createServer(app);

const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // permitir tools/health-check
    if (CLIENT_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'), false);
  }
}));

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGINS.length ? CLIENT_ORIGINS : '*',
    methods: ['GET','POST'],
    transports: ['websocket','polling']
  }
});

io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);
  // ... tus eventos: chat, dm, resetDM, clearChat ...
});

app.get('/healthz', (_req,res)=>res.send('ok'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`API on :${PORT}`));

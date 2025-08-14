import { Server } from 'socket.io';
import { getRoomMembers, membersArray, roomChars } from './state.js';
import { publicCombatState, startCombat, rerollCombat, nextTurn, prevTurn, endCombat, applySettings, scheduleAdvance } from './combat.js';
import { handleDMCommands } from './commands.js';
import { detectImplicitCmd, maybeAutoStartCombat } from './detect.js';
import { askDM } from './dm.js';
import { rollDice } from './dice.js';
import { getRoomContext } from './room-context.js';
import { getRoomCharsMap, schedulePartySynthesis } from './party.js';
import { stripCmdLines } from './utils.js';

export function attachSocket(httpServer, corsOrigin = '*') {
  const io = new Server(httpServer, { cors: { origin: corsOrigin } });

  io.on('connection', (socket) => {
    let currentRoom = null;
    let nickname = `Jugador-${socket.id.slice(0, 4)}`;

    function joinRoom(roomId, name) {
      if (currentRoom) socket.leave(currentRoom);
      currentRoom = roomId || 'default';
      if (name && typeof name === 'string') nickname = name.trim().slice(0, 40);

      socket.join(currentRoom);
      socket.emit('joined', { roomId: currentRoom, nickname });

      const members = getRoomMembers(currentRoom);
      members.set(socket.id, { id: socket.id, name: nickname });
      io.to(currentRoom).emit('presence', membersArray(currentRoom));

      socket.to(currentRoom).emit('system', `${nickname} se ha unido a la mesa.`);

      const st = requireCombatState(currentRoom);
      if (st) socket.emit('combat:update', publicCombatState(st));
    }

    function requireCombatState(roomId) {
      // acceso directo opcional; si no existe, retorna undefined
      return null; // simple placeholder; combat emite por eventos
    }

    // Presencia
    socket.on('join', ({ roomId, name }) => joinRoom(roomId, name));
    socket.on('getPresence', () => { if (currentRoom) io.to(currentRoom).emit('presence', membersArray(currentRoom)); });

    // Chat + IA DM + comandos
    socket.on('chat', async ({ text, dm = false }) => {
      if (!currentRoom) return;
      const payload = { from: nickname, text, ts: Date.now() };
      io.to(currentRoom).emit('chat', payload);

      if (dm || /^@dm\b/i.test(text)) {
        const userText = text.replace(/^@dm\b/i, '').trim();

        // 1) Comando implícito inmediato
        const implicit = detectImplicitCmd(userText);
        if (implicit) {
          switch (implicit.cmd) {
            case 'START_COMBAT': startCombat(io, currentRoom, {}); break;
            case 'REROLL':       rerollCombat(io, currentRoom);    break;
            case 'NEXT_TURN':    nextTurn(io, currentRoom);        break;
            case 'PREV_TURN':    prevTurn(io, currentRoom);        break;
            case 'END_COMBAT':   endCombat(io, currentRoom);       break;
            case 'SETTINGS':     applySettings(io, currentRoom, implicit.opts || {}); break;
          }
        }

        // 1.5) Heurística: jugador provoca encuentro hostil
        maybeAutoStartCombat(io, currentRoom, userText);

        // 2) Pide narrativa a la IA
        const replyRaw = await askDM(currentRoom, userText || text);

        // 3) Ejecuta comandos que vengan en la respuesta del DM
        handleDMCommands(io, currentRoom, replyRaw);

        // 4) Limpia [CMD:...] antes de mostrar
        const reply = stripCmdLines(replyRaw);
        if (reply.trim()) {
          io.to(currentRoom).emit('dm', { from: 'DM', text: reply, ts: Date.now() });
        }

        // 4.5) Heurística: si el DM describió hostilidad sin CMD
        maybeAutoStartCombat(io, currentRoom, reply);
      }
    });

    // Tiradas
    socket.on('roll', ({ notation }) => {
      if (!currentRoom) return;
      const result = rollDice(notation);
      if (!result.ok) { socket.emit('system', `🎲 Error: ${result.error}`); return; }
      const { rolls, mod, total, faces, count } = result;
      io.to(currentRoom).emit('roll', {
        from: nickname,
        notation,
        detail: `${count}d${faces}${mod >= 0 ? `+${mod}` : mod}`,
        rolls,
        total,
        ts: Date.now()
      });
    });

    // Anuncios manuales
    socket.on('announce', (payload) => {
      if (!currentRoom) return;
      const text = (typeof payload === 'string' ? payload : payload?.text) || '';
      if (!text.trim()) return;
      io.to(currentRoom).emit('system', text.toString().slice(0, 2000));
    });

    // Estado actual de combate
    socket.on('combat:get', () => {
      if (!currentRoom) return;
      // combat:update lo emite combat.js en cada cambio; aquí solo “ping” inicial
    });

    // Finalizar turno (solo jugador activo; validación en server/combat loop)
    socket.on('combat:finishTurn', () => {
      // la lógica de validación está en tu servidor original;
      // si la necesitas completa, puedes moverla a combat.js y exponer finishTurn(io, roomId, socketId)
    });

    // Fichas de personaje
    socket.on('character:upsert', ({ sheet }) => {
      if (!currentRoom) return;
      const map = getRoomCharsMap(currentRoom);
      map.set(socket.id, { id: socket.id, name: nickname, sheet });
      io.to(currentRoom).emit('character:all', Array.from(map.values()));
      schedulePartySynthesis(io, currentRoom);
    });

    socket.on('character:getAll', () => {
      if (!currentRoom) return;
      const map = getRoomCharsMap(currentRoom);
      socket.emit('character:all', Array.from(map.values()));
    });

    // Limpiar chat (solo vista)
    socket.on('chat:clear', ({ by }) => {
      if (!currentRoom) return;
      const who = (by || nickname || 'alguien').toString().slice(0, 40);
      io.to(currentRoom).emit('chat:cleared', { by: who, ts: Date.now() });
      io.to(currentRoom).emit('system', `🧹 ${who} ha vaciado el chat (solo la vista).`);
    });

    // Reiniciar contexto del DM (historial)
    socket.on('dm:reset', () => {
      if (!currentRoom) return;
      const ctx = getRoomContext(currentRoom);
      ctx.messages = [];
      ctx.lastAskAt = 0;
      io.to(currentRoom).emit('system', '♻️ El contexto del DM se ha reiniciado para esta mesa.');
    });

    // Desconexión
    socket.on('disconnect', () => {
      if (!currentRoom) return;
      const mem = getRoomMembers(currentRoom);
      mem.delete(socket.id);
      io.to(currentRoom).emit('presence', membersArray(currentRoom));
      socket.to(currentRoom).emit('system', `${nickname} ha salido de la mesa.`);

      const map = roomChars.get(currentRoom);
      if (map) {
        map.delete(socket.id);
        io.to(currentRoom).emit('character:all', Array.from(map.values()));
        schedulePartySynthesis(io, currentRoom);
      }
    });
  });

  return io;
}

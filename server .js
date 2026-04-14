const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));

const io = new Server(server, {
  cors: { origin: "*" },
  // Permite reconexiones rápidas sin perder la sala
  pingTimeout: 30000,
  pingInterval: 10000,
});

// ── Estructura de sala ──────────────────────────────────────────────────────
// rooms[roomId] = {
//   players:   [{ socketId, playerId, name }],   // orden = índice de asiento
//   started:   bool,
//   gameState: object | null,                     // último estado del host
// }
const rooms = {};

// ── Helpers ─────────────────────────────────────────────────────────────────
function getRoomOfSocket(socketId) {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.players.some(p => p.socketId === socketId)) return roomId;
  }
  return null;
}

// ── Conexión ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[+] Conectado:", socket.id);

  // ── CREAR SALA ────────────────────────────────────────────────────────────
  // Cliente emite: { roomId, name }
  socket.on("createRoom", ({ roomId, name }) => {
    if (rooms[roomId]) {
      socket.emit("error", "La sala ya existe. Probá con otro código.");
      return;
    }

    rooms[roomId] = { players: [], started: false, gameState: null };

    const playerId = 0; // host siempre es el jugador 0
    rooms[roomId].players.push({ socketId: socket.id, playerId, name });
    socket.join(roomId);

    console.log(`[SALA] Creada: ${roomId} por ${name} (${socket.id})`);

    // Confirmar al host su playerId y la lista de jugadores
    socket.emit("roomJoined", {
      playerId,
      players: rooms[roomId].players.map(p => ({ id: p.playerId, name: p.name })),
    });
  });

  // ── UNIRSE A SALA ─────────────────────────────────────────────────────────
  // Cliente emite: { roomId, name }
  socket.on("joinRoom", ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) {
      console.warn(`[JOIN] ❌ Jugador intenta unirse a sala inexistente: ${roomId}`);
      socket.emit("error", `No existe la sala ${roomId}.`);
      return;
    }
    if (room.started) {
      console.warn(`[JOIN] ❌ Jugador ${name} intenta unirse a ${roomId} pero partida ya comenzó`);
      socket.emit("error", "La partida ya comenzó.");
      return;
    }
    if (room.players.length >= 6) {
      console.warn(`[JOIN] ❌ Jugador ${name} intenta unirse a ${roomId} pero está llena (${room.players.length}/6)`);
      socket.emit("error", "La sala está llena (máx. 6).");
      return;
    }

    const playerId = room.players.length;
    room.players.push({ socketId: socket.id, playerId, name });
    socket.join(roomId);

    console.log(`[JOIN] ✅ ${name} se unió a ${roomId} como jugador ${playerId} (total: ${room.players.length})`);

    // Confirmar al recién unido
    socket.emit("roomJoined", {
      playerId,
      players: room.players.map(p => ({ id: p.playerId, name: p.name })),
    });
    console.log(`[JOIN]   → Confirmado: jugador ${playerId} en sala ${roomId}`);

    // Notificar a TODOS (incluido host) la lista actualizada
    io.to(roomId).emit("playersUpdate", {
      players: room.players.map(p => ({ id: p.playerId, name: p.name })),
    });
    console.log(`[JOIN]   → Notificando playersUpdate a ${room.players.length} clientes`);
  });

  // ── INICIAR PARTIDA (solo el host la envía) ───────────────────────────────
  // Cliente emite: { roomId }
  socket.on("startGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      console.warn(`[START] ❌ Intento de iniciar sala inexistente: ${roomId}`);
      socket.emit("error", `Sala ${roomId} no existe`);
      return;
    }

    const sender = room.players.find(p => p.socketId === socket.id);
    if (!sender) {
      console.warn(`[START] ❌ Socket ${socket.id} intenta iniciar pero NO está en sala ${roomId}`);
      socket.emit("error", "No estás en esa sala.");
      return;
    }
    if (sender.playerId !== 0) {
      console.warn(`[START] ❌ Jugador ${sender.playerId} (no host) intenta iniciar partida en ${roomId}`);
      socket.emit("error", "Solo el host puede iniciar la partida.");
      return;
    }

    room.started = true;
    console.log(`[START] ✅ Partida iniciada en ${roomId} con ${room.players.length} jugadores`);
    const playerList = room.players.map(q => ({ id: q.playerId, name: q.name }));
    console.log(`[START] 📢 Enviando 'gameStarted' a ${room.players.length} clientes (host + ${room.players.length - 1} jugadores)`);

    // Avisar a TODOS — cada cliente recibe su propio myPlayerId
    room.players.forEach(p => {
      console.log(`[START]   → Enviando a jugador ${p.playerId} (socket: ${p.socketId.substring(0, 8)}...)`);
      io.to(p.socketId).emit("gameStarted", {
        players: playerList,
        myPlayerId: p.playerId,  // cada uno recibe su propio índice
      });
    });
  });

  // ── BROADCAST ESTADO (solo el host lo envía) ──────────────────────────────
  // El host calcula el estado del juego y lo difunde a los clientes.
  // Cliente emite: { roomId, state }
  socket.on("gameState", ({ roomId, state }) => {
    const room = rooms[roomId];
    if (!room) {
      console.warn(`[BROADCAST] ❌ Sala ${roomId} NO EXISTE`);
      return;
    }

    const sender = room.players.find(p => p.socketId === socket.id);
    if (!sender) {
      console.warn(`[BROADCAST] ❌ Socket ${socket.id} no pertenece a sala ${roomId}`);
      return;
    }
    if (sender.playerId !== 0) {
      console.warn(`[BROADCAST] ❌ Socket intenta broadcast pero NO es host (es player ${sender.playerId})`);
      return;
    }

    room.gameState = state; // guardar último estado (por si alguien reconecta)
    
    console.log(`[BROADCAST] 📡 HOST enviando gameState a sala ${roomId}`);
    console.log(`  - fase: ${state.phase}, pot: $${state.pot}, actionIndex: ${state.actionIndex}`);
    console.log(`  - jugadores en sala: ${room.players.length}`);
    console.log(`  - reenviando a ${room.players.length - 1} clientes (excepto host)`);

    // Reenviar a todos los clientes EXCEPTO al host
    socket.to(roomId).emit("gameState", state);
  });

  // ── PEDIR ESTADO ACTUAL (cliente que reconecta) ───────────────────────────
  socket.on("requestState", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      console.warn(`[REQUEST] ❌ Cliente solicita estado de sala inexistente: ${roomId}`);
      return;
    }
    if (!room.gameState) {
      console.warn(`[REQUEST] ⚠️  Cliente solicita estado pero gameState aún es null en sala ${roomId}`);
      return;
    }
    console.log(`[REQUEST] 📤 Enviando gameState guardado a cliente de sala ${roomId}`);
    socket.emit("gameState", room.gameState);
  });

  // ── ACCIÓN DE JUGADOR (cliente → host) ────────────────────────────────────
  // Cuando es el turno de un cliente, éste envía su acción al servidor
  // y el servidor la retransmite al host para que la procese.
  // Cliente emite: { roomId, playerId, action, raiseAmount }
  socket.on("playerAction", ({ roomId, playerId, action, raiseAmount }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;

    const sender = room.players.find(p => p.socketId === socket.id);
    if (!sender) {
      console.warn(`[ACCIÓN] Socket ${socket.id} no está en la sala ${roomId}`);
      return;
    }

    // Verificar que el socket corresponde al playerId que dice ser
    if (sender.playerId !== playerId) {
      console.warn(`[ACCIÓN] Rechazada: ${socket.id} dice ser jugador ${playerId} pero es ${sender.playerId}`);
      return;
    }

    console.log(`[ACCIÓN] Jugador ${playerId} en ${roomId}: ${action} ${raiseAmount ?? ''}`);

    // Reenviar SOLO al host (jugador 0)
    const host = room.players.find(p => p.playerId === 0);
    if (host) {
      io.to(host.socketId).emit("playerAction", { playerId, action, raiseAmount, _ts: Date.now() });
    }
  });

  // ── DESCONEXIÓN ───────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log("[-] Desconectado:", socket.id);
    const roomId = getRoomOfSocket(socket.id);
    if (!roomId) return;

    const room = rooms[roomId];
    const player = room.players.find(p => p.socketId === socket.id);

    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log(`[SALA] Sala ${roomId} eliminada (sin jugadores)`);
    } else {
      // Notificar al resto
      io.to(roomId).emit("playerLeft", {
        playerId: player?.playerId,
        name: player?.name,
        players: room.players.map(p => ({ id: p.playerId, name: p.name })),
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

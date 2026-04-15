const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const path = require("path");

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "index.html");
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error("❌ Error enviando index.html:", err);
      res.status(500).send("Error cargando la app");
    }
  });
});

const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 30000,
  pingInterval: 10000,
});

// ── Estructura de sala ──────────────────────────────────────────────────────
// rooms[roomId] = {
//   players:   [{ socketId, playerId, name, isBot }],
//   started:   bool,
//   gameState: object | null,
// }
const rooms = {};

// ── Helpers ──────────────────────────────────────────────────────────────────
function getRoomOfSocket(socketId) {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.players.some(p => p.socketId === socketId)) return roomId;
  }
  return null;
}

function normalizeRoomId(id) {
  return (id || '').toString().trim().toUpperCase();
}

// ── BOT: entrada ficticia que representa al bot de ML en la sala ─────────────
// El bot NO tiene socketId real — usa el centinela "BOT" para que el servidor
// no intente enviarle eventos directamente.
// isBot: true  →  el host lo maneja localmente; los clientes lo reciben
//                 en playerList para poder renderizarlo en la mesa.
const BOT_SOCKET_SENTINEL = "BOT";

function createBotEntry(playerId) {
  return {
    socketId: BOT_SOCKET_SENTINEL,
    playerId,
    name: "ML Bot",
    isBot: true,
  };
}

// ── Conexión ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[+] Conectado:", socket.id);

  // ── CREAR SALA ─────────────────────────────────────────────────────────────
  // Cliente emite: { roomId, name }
  socket.on("createRoom", ({ roomId, name }) => {
    roomId = normalizeRoomId(roomId);

    if (!roomId || roomId.length < 4) {
      socket.emit("error", "Código de sala inválido.");
      return;
    }
    if (rooms[roomId]) {
      socket.emit("error", "La sala ya existe. Probá con otro código.");
      return;
    }

    rooms[roomId] = { players: [], started: false, gameState: null };

    // ── 1. Registrar al host (playerId 0) ──────────────────────────────────
    const hostEntry = { socketId: socket.id, playerId: 0, name, isBot: false };
    rooms[roomId].players.push(hostEntry);
    socket.join(roomId);

    // ── 2. Registrar al bot (playerId 1) — SIEMPRE, en todas las salas ─────
    // FIX CRÍTICO: el bot se agrega aquí, al crear la sala, para que
    // TODOS los jugadores que se unan reciban la misma lista con el bot.
    const botEntry = createBotEntry(1);
    rooms[roomId].players.push(botEntry);

    console.log(`[SALA] Creada: ${roomId} por ${name} (${socket.id}) | Bot registrado como jugador 1`);

    socket.emit("roomJoined", {
      playerId: 0,
      players: rooms[roomId].players.map(p => ({ id: p.playerId, name: p.name, isBot: p.isBot })),
    });
  });

  // ── UNIRSE A SALA ──────────────────────────────────────────────────────────
  // Cliente emite: { roomId, name }
  socket.on("joinRoom", ({ roomId, name }) => {
    roomId = normalizeRoomId(roomId);

    console.log(`[JOIN] Intento: "${roomId}" | Salas activas: [${Object.keys(rooms).join(', ')}]`);

    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", `No existe la sala "${roomId}". Verificá el código e intentá de nuevo.`);
      return;
    }
    if (room.started) {
      socket.emit("error", "La partida ya comenzó.");
      return;
    }
    // El límite real de HUMANOS es 6; el bot ya ocupa un asiento lógico pero
    // no cuenta como "jugador en sala" a efectos del tope de conexiones.
    const humanCount = room.players.filter(p => !p.isBot).length;
    if (humanCount >= 6) {
      socket.emit("error", "La sala está llena (máx. 6 humanos).");
      return;
    }

    // FIX: el nuevo jugador humano recibe el próximo id libre DESPUÉS del bot.
    // Los ids ya asignados (incluido el bot) no se reutilizan.
    const usedIds = room.players.map(p => p.playerId);
    const playerId = Math.max(...usedIds) + 1;

    room.players.push({ socketId: socket.id, playerId, name, isBot: false });
    socket.join(roomId);

    console.log(`[JOIN] ✅ ${name} → jugador ${playerId} en ${roomId} (total: ${room.players.length}, bot incluido)`);

    // Confirmar al recién unido — incluye al bot en la lista
    socket.emit("roomJoined", {
      playerId,
      players: room.players.map(p => ({ id: p.playerId, name: p.name, isBot: p.isBot })),
    });

    // Notificar a TODOS la lista actualizada (con bot)
    io.to(roomId).emit("playersUpdate", {
      players: room.players.map(p => ({ id: p.playerId, name: p.name, isBot: p.isBot })),
    });
    console.log(`[JOIN]   → playersUpdate enviado a ${room.players.filter(p=>!p.isBot).length} clientes humanos`);
  });

  // ── INICIAR PARTIDA (solo el host) ─────────────────────────────────────────
  // Cliente emite: { roomId }
  socket.on("startGame", ({ roomId }) => {
    roomId = normalizeRoomId(roomId);
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", `Sala ${roomId} no existe`);
      return;
    }

    const sender = room.players.find(p => p.socketId === socket.id);
    if (!sender) {
      socket.emit("error", "No estás en esa sala.");
      return;
    }
    if (sender.playerId !== 0) {
      socket.emit("error", "Solo el host puede iniciar la partida.");
      return;
    }

    room.started = true;

    // FIX CRÍTICO: playerList incluye al bot (isBot: true).
    // Cada cliente — host y no-host — recibe la MISMA lista completa,
    // y cada uno puede identificar al bot por la propiedad isBot.
    const playerList = room.players.map(p => ({
      id:    p.playerId,
      name:  p.name,
      isBot: p.isBot,
    }));

    console.log(`[START] ✅ Partida iniciada en ${roomId} | jugadores: ${JSON.stringify(playerList)}`);

    // Enviar solo a los humanos (el bot no tiene socket real)
    const humanPlayers = room.players.filter(p => !p.isBot);
    humanPlayers.forEach(p => {
      io.to(p.socketId).emit("gameStarted", {
        players: playerList,      // lista completa con bot
        myPlayerId: p.playerId,   // id propio de cada cliente
      });
      console.log(`[START]   → gameStarted a jugador ${p.playerId} (${p.name})`);
    });
  });

  // ── BROADCAST ESTADO (host → clientes) ────────────────────────────────────
  // Cliente emite: { roomId, state }
  socket.on("gameState", ({ roomId, state }) => {
    roomId = normalizeRoomId(roomId);
    const room = rooms[roomId];
    if (!room) return;

    const sender = room.players.find(p => p.socketId === socket.id);
    if (!sender || sender.playerId !== 0) return;

    room.gameState = state;

    console.log(`[BROADCAST] 📡 gameState → sala ${roomId} | fase: ${state.phase}, pot: $${state.pot}`);

    // Reenviar a todos EXCEPTO al host (sin tocar la lógica del bot:
    // el host ya lo maneja localmente)
    socket.to(roomId).emit("gameState", state);
  });

  // ── PEDIR ESTADO ACTUAL (reconexión) ──────────────────────────────────────
  socket.on("requestState", ({ roomId }) => {
    roomId = normalizeRoomId(roomId);
    const room = rooms[roomId];
    if (!room || !room.gameState) return;
    socket.emit("gameState", room.gameState);
  });

  // ── ACCIÓN DE JUGADOR (cliente → host) ────────────────────────────────────
  // Cliente emite: { roomId, playerId, action, raiseAmount }
  socket.on("playerAction", ({ roomId, playerId, action, raiseAmount }) => {
    roomId = normalizeRoomId(roomId);
    const room = rooms[roomId];
    if (!room || !room.started) return;

    const sender = room.players.find(p => p.socketId === socket.id);
    if (!sender) return;
    if (sender.playerId !== playerId) {
      console.warn(`[ACCIÓN] Rechazada: socket dice ser jugador ${playerId} pero es ${sender.playerId}`);
      return;
    }

    console.log(`[ACCIÓN] Jugador ${playerId} en ${roomId}: ${action} ${raiseAmount ?? ''}`);

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

    // Solo eliminar al jugador humano; el bot permanece en sala
    room.players = room.players.filter(p => p.socketId !== socket.id);

    const humanPlayersLeft = room.players.filter(p => !p.isBot);
    if (humanPlayersLeft.length === 0) {
      delete rooms[roomId];
      console.log(`[SALA] Sala ${roomId} eliminada (sin humanos)`);
    } else {
      io.to(roomId).emit("playerLeft", {
        playerId: player?.playerId,
        name: player?.name,
        players: room.players.map(p => ({ id: p.playerId, name: p.name, isBot: p.isBot })),
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

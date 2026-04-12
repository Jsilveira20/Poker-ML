const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

const io = new Server(server, {
  cors: { origin: "*" }
});

// 🔥 guardar salas
const rooms = {};

io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  // 🟢 CREAR SALA
 socket.on("createRoom", (roomId) => {
  socket.join(roomId);

  rooms[roomId] = {
    players: [socket.id]
  };

  // 🔥 enviar estado inicial
  io.to(roomId).emit("playersUpdate", rooms[roomId].players);
});

  // 🟢 UNIRSE A SALA
  socket.on("joinRoom", (roomId) => {
  socket.join(roomId);

  if (!rooms[roomId]) {
    rooms[roomId] = { players: [] };
  }

  // evitar duplicados
  if (!rooms[roomId].players.includes(socket.id)) {
    rooms[roomId].players.push(socket.id);
  }

  console.log("Jugador unido a:", roomId);

  // 🔥 MANDAR ESTADO A TODOS (incluido host)
  io.to(roomId).emit("playersUpdate", rooms[roomId].players);
});

  // 🟢 INICIAR PARTIDA
  socket.on("startGame", (roomId) => {
    const room = rooms[roomId];

    if (!room) return;

    console.log("Iniciando partida en:", roomId);

    // 🔥 enviar a TODOS los jugadores de la sala
    io.to(roomId).emit("gameStarted", {
      players: room.players
    });
  });

  // 🔴 DESCONECTAR
  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);

    // sacar jugador de salas
    for (let roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(
        (id) => id !== socket.id
      );
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});



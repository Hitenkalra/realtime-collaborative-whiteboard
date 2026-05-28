const open = (...args) =>
  import("open").then(({ default: open }) => open(...args));
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 5000;
const clientDistPath = path.join(__dirname, "dist");
const clientIndexPath = path.join(clientDistPath, "index.html");
const rooms = new Map();
const palette = ["#4f8cff", "#22c55e", "#f97316", "#ef4444", "#a855f7", "#06b6d4"];

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_, response) => {
  response.json({
    ok: true,
    uptime: process.uptime(),
    rooms: rooms.size,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/rooms/:roomId", (request, response) => {
  const room = getRoom(request.params.roomId);
  response.json(roomSnapshot(request.params.roomId, room));
});

app.use(express.static(clientDistPath));

app.get("*", (_, response) => {
  if (fs.existsSync(clientIndexPath)) {
    response.sendFile(clientIndexPath);
    return;
  }

  response.status(404).json({
    error: "Frontend build not found. Run `npm run build` before `npm start`.",
  });
});

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000,
});

function getRoom(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!rooms.has(normalizedRoomId)) {
    rooms.set(normalizedRoomId, {
      createdAt: new Date().toISOString(),
      elements: [],
      messages: [],
      participants: new Map(),
    });
  }

  return rooms.get(normalizedRoomId);
}

function normalizeRoomId(roomId) {
  return String(roomId || "strategy-room").trim().slice(0, 80) || "strategy-room";
}

function roomParticipants(room) {
  return [...room.participants.values()];
}

function roomSnapshot(roomId, room) {
  return {
    id: roomId,
    createdAt: room.createdAt,
    participants: roomParticipants(room),
    elements: room.elements,
    messages: room.messages,
  };
}

function isRoomMember(socket, roomId) {
  return socket.data.rooms?.has(roomId);
}

function broadcastParticipants(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit("participants", roomParticipants(room));
}

function pruneRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.participants.size === 0) rooms.delete(roomId);
}

function sanitizeElement(element) {
  if (!element || typeof element !== "object") return null;
  return {
    ...element,
    id: String(element.id || `${Date.now()}-${Math.random()}`),
    color: String(element.color || "#2563eb"),
    size: Math.max(1, Math.min(80, Number(element.size) || 4)),
  };
}

function leaveRoom(socket, roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const room = rooms.get(normalizedRoomId);
  if (!room) return;

  room.participants.delete(socket.id);
  socket.leave(normalizedRoomId);
  socket.data.rooms?.delete(normalizedRoomId);
  socket.to(normalizedRoomId).emit("participant-left", socket.id);
  broadcastParticipants(normalizedRoomId);
  pruneRoom(normalizedRoomId);
}

io.on("connection", (socket) => {
  socket.data.rooms = new Set();
  console.log("[socket] connected", socket.id);

  socket.on("join-room", (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId);

    // A socket belongs to one active app room at a time; rejoin is idempotent.
    [...socket.data.rooms].filter((id) => id !== roomId).forEach((id) => leaveRoom(socket, id));

    const room = getRoom(roomId);
    const existing = room.participants.get(socket.id);
    const participant = {
      id: socket.id,
      name: String(payload.name || existing?.name || "Guest Collaborator").slice(0, 80),
      avatar: String(payload.avatar || existing?.avatar || "GC").slice(0, 3),
      color: existing?.color || palette[room.participants.size % palette.length],
      role: existing?.role || (room.participants.size === 0 ? "host" : "participant"),
      hand: existing?.hand || false,
      media: existing?.media || { camera: false, mic: false, sharing: false },
      joinedAt: existing?.joinedAt || new Date().toISOString(),
    };

    socket.join(roomId);
    socket.data.rooms.add(roomId);
    room.participants.set(socket.id, participant);

    socket.emit("room-state", roomSnapshot(roomId, room));
    socket.to(roomId).emit("participant-joined", participant);
    broadcastParticipants(roomId);
  });

  socket.on("leave-room", (roomId) => leaveRoom(socket, roomId));

  socket.on("whiteboard-preview", ({ roomId, element } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId)) return;
    const sanitized = sanitizeElement(element);
    if (!sanitized) return;

    console.log("[draw receive] preview", {
      roomId: normalizedRoomId,
      socketId: socket.id,
      elementId: sanitized.id,
      tool: sanitized.tool,
      points: sanitized.points?.length || 0,
    });
    socket.to(normalizedRoomId).emit("whiteboard-preview", {
      element: sanitized,
      authorId: socket.id,
    });
  });

  socket.on("whiteboard-element", ({ roomId, element } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId)) return;
    const sanitized = sanitizeElement(element);
    if (!sanitized) return;

    const room = getRoom(normalizedRoomId);
    const existingIndex = room.elements.findIndex((item) => item.id === sanitized.id);
    if (existingIndex >= 0) room.elements[existingIndex] = sanitized;
    else room.elements.push(sanitized);

    console.log("[draw receive] commit", {
      roomId: normalizedRoomId,
      socketId: socket.id,
      elementId: sanitized.id,
      tool: sanitized.tool,
      points: sanitized.points?.length || 0,
    });
    io.to(normalizedRoomId).emit("whiteboard-element", {
      element: sanitized,
      authorId: socket.id,
    });
  });

  socket.on("whiteboard-sync", ({ roomId, elements } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId)) return;

    const room = getRoom(normalizedRoomId);
    room.elements = Array.isArray(elements)
      ? elements.map(sanitizeElement).filter(Boolean).slice(-2500)
      : [];
    io.to(normalizedRoomId).emit("board-state", { elements: room.elements });
  });

  socket.on("clear-board", (roomId) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId)) return;

    const room = getRoom(normalizedRoomId);
    room.elements = [];
    console.log("[draw receive] clear", { roomId: normalizedRoomId, socketId: socket.id });
    io.to(normalizedRoomId).emit("board-state", { elements: [] });
  });

  socket.on("cursor-update", ({ roomId, cursor } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId) || !cursor) return;

    socket.to(normalizedRoomId).emit("cursor-update", {
      id: socket.id,
      cursor: {
        x: Number(cursor.x) || 0,
        y: Number(cursor.y) || 0,
      },
    });
  });

  socket.on("chat-message", ({ roomId, text } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId) || !text) return;

    const room = getRoom(normalizedRoomId);
    const participant = room.participants.get(socket.id);
    const message = {
      id: `${Date.now()}-${socket.id}`,
      sender: participant?.name || "Guest",
      senderId: socket.id,
      text: String(text).trim().slice(0, 2000),
      sentAt: new Date().toISOString(),
    };

    if (!message.text) return;
    room.messages.push(message);
    room.messages = room.messages.slice(-200);
    io.to(normalizedRoomId).emit("chat-message", message);
  });

  socket.on("raise-hand", ({ roomId, hand } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId)) return;

    const room = getRoom(normalizedRoomId);
    const participant = room.participants.get(socket.id);
    if (!participant) return;

    participant.hand = Boolean(hand);
    broadcastParticipants(normalizedRoomId);
  });

  socket.on("media-state", ({ roomId, state } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!isRoomMember(socket, normalizedRoomId)) return;

    const room = getRoom(normalizedRoomId);
    const participant = room.participants.get(socket.id);
    if (!participant) return;

    participant.media = { ...participant.media, ...(state || {}) };
    broadcastParticipants(normalizedRoomId);
  });

  // WebRTC payloads are relayed only to sockets in the same Socket.IO room.
  socket.on("webrtc-offer", ({ roomId, to, offer } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (isRoomMember(socket, normalizedRoomId) && to) {
      socket.to(to).emit("webrtc-offer", { roomId: normalizedRoomId, from: socket.id, offer });
    }
  });

  socket.on("webrtc-answer", ({ roomId, to, answer } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (isRoomMember(socket, normalizedRoomId) && to) {
      socket.to(to).emit("webrtc-answer", { roomId: normalizedRoomId, from: socket.id, answer });
    }
  });

  socket.on("webrtc-ice-candidate", ({ roomId, to, candidate } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (isRoomMember(socket, normalizedRoomId) && to) {
      socket.to(to).emit("webrtc-ice-candidate", {
        roomId: normalizedRoomId,
        from: socket.id,
        candidate,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected", socket.id);
    [...socket.data.rooms].forEach((roomId) => leaveRoom(socket, roomId));
  });
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

server.listen(port, async () => {
  console.log(`Realtime whiteboard server listening on ${port}`);
  console.log(`Local URL: http://localhost:${port}`);

  await open(`http://localhost:${port}`);
});
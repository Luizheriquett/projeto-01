/**
 * ChatPatty — Servidor de sinalização WebRTC
 * ------------------------------------------------------------
 * Responsabilidades deste servidor:
 *  - Servir o front-end estático
 *  - Gerenciar salas e presença de usuários
 *  - Retransmitir mensagens de sinalização WebRTC (offer/answer/ICE)
 *    entre os participantes de uma mesma sala (o áudio/vídeo/tela
 *    NUNCA passa por aqui — vai direto peer-to-peer via WebRTC)
 *  - Aplicar validação, sanitização, rate limiting e tokens de sala
 *
 * O servidor não grava nem retransmite mídia. Ele é puramente
 * um "cartório" que apresenta os participantes uns aos outros.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { customAlphabet } = require('nanoid');

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim());

const MAX_USERS_PER_ROOM = parseInt(process.env.MAX_USERS_PER_ROOM || '12', 10);
const MAX_NAME_LENGTH = 24;
const ROOM_ID_ALPHABET = '346789ABCDEFGHJKLMNPQRTUVWXYZabcdefghijkmnpqrtuvwxyz';
const generateRoomId = customAlphabet(ROOM_ID_ALPHABET, 8);

// Servidores ICE (STUN públicos + placeholder para TURN próprio).
// Em produção, um TURN é praticamente obrigatório: STUN sozinho falha
// atrás de NAT simétrico / redes corporativas / 4G restritivo.
function buildIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  return iceServers;
}

// ---------------------------------------------------------------------------
// App / servidor HTTP
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
    credentials: true,
  })
);
app.use(compression());
app.use(express.json({ limit: '32kb' }));

// Rate limiting HTTP geral
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Rate limiting mais estrito para criação de salas
const createRoomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas salas criadas. Tente novamente em instantes.' },
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: NODE_ENV === 'production' ? '1d' : 0 }));

// ---------------------------------------------------------------------------
// Estado em memória: salas e participantes
// ---------------------------------------------------------------------------

/**
 * rooms: Map<roomId, {
 *   id, createdAt,
 *   users: Map<socketId, { id, name, avatar, joinedAt, muted, sharingScreen }>
 * }>
 */
const rooms = new Map();

function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  // Remove tags/entidades HTML e caracteres de controle — evita XSS,
  // já que nomes de usuário são renderizados no DOM de todo mundo na sala.
  const stripped = input
    .replace(/<[^>]*>/g, '')
    .replace(/[<>&"'`]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  return stripped.slice(0, maxLen);
}

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && /^[A-Za-z0-9]{4,12}$/.test(roomId);
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { id: roomId, createdAt: Date.now(), users: new Map() });
  }
  return rooms.get(roomId);
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    muted: u.muted,
    sharingScreen: u.sharingScreen,
    joinedAt: u.joinedAt,
  };
}

function roomSnapshot(room) {
  return Array.from(room.users.values()).map(publicUser);
}

function cleanupEmptyRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.users.size === 0) {
    rooms.delete(roomId);
  }
}

// ---------------------------------------------------------------------------
// Rotas HTTP
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

app.post('/api/rooms', createRoomLimiter, (req, res) => {
  let roomId = generateRoomId();
  // Garantir unicidade (probabilidade de colisão é irrisória, mas o ponto
  // de "profissional" é não confiar em sorte).
  while (rooms.has(roomId)) roomId = generateRoomId();
  getOrCreateRoom(roomId);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    return res.status(400).json({ error: 'ID de sala inválido' });
  }
  const room = rooms.get(roomId);
  res.json({
    exists: !!room,
    userCount: room ? room.users.size : 0,
    full: room ? room.users.size >= MAX_USERS_PER_ROOM : false,
  });
});

app.get('/api/ice-servers', (req, res) => {
  res.json({ iceServers: buildIceServers() });
});

// SPA fallback para /room/:id
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Socket.IO — sinalização
// ---------------------------------------------------------------------------

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
    credentials: true,
  },
  maxHttpBufferSize: 64 * 1024, // payloads de sinalização são pequenos
  pingTimeout: 60000,
  pingInterval: 10000,
});

// Rate limiting simples por socket para eventos de sinalização (evita flood)
const SIGNAL_WINDOW_MS = 1000;
const SIGNAL_MAX_PER_WINDOW = 40;

function withinRateLimit(socket) {
  const now = Date.now();
  if (!socket.data.signalWindow || now - socket.data.signalWindow.start > SIGNAL_WINDOW_MS) {
    socket.data.signalWindow = { start: now, count: 0 };
  }
  socket.data.signalWindow.count += 1;
  return socket.data.signalWindow.count <= SIGNAL_MAX_PER_WINDOW;
}

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.userId = socket.id;

  socket.on('join-room', ({ roomId, name, avatar }, ack) => {
    try {
      if (!isValidRoomId(roomId)) {
        return ack?.({ ok: false, error: 'ID de sala inválido' });
      }

      const cleanName = sanitizeText(name, MAX_NAME_LENGTH) || 'Convidado';
      const cleanAvatar = sanitizeText(avatar, 8) || '🙂';

      const room = getOrCreateRoom(roomId);

      if (room.users.size >= MAX_USERS_PER_ROOM) {
        return ack?.({ ok: false, error: 'Sala cheia' });
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.name = cleanName;

      const userRecord = {
        id: socket.id,
        name: cleanName,
        avatar: cleanAvatar,
        joinedAt: Date.now(),
        muted: true,
        sharingScreen: false,
      };
      room.users.set(socket.id, userRecord);

      // Confirma pro próprio usuário quem já está na sala + config ICE
      ack?.({
        ok: true,
        selfId: socket.id,
        users: roomSnapshot(room).filter((u) => u.id !== socket.id),
        iceServers: buildIceServers(),
      });

      // Avisa os demais que alguém entrou
      socket.to(roomId).emit('user-joined', publicUser(userRecord));
    } catch (err) {
      ack?.({ ok: false, error: 'Erro ao entrar na sala' });
    }
  });

  // Retransmissão de sinalização WebRTC (offer, answer, ice-candidate).
  // O servidor não interpreta o SDP, apenas encaminha para o destinatário certo.
  socket.on('signal', ({ to, data }) => {
    if (!withinRateLimit(socket)) return;
    if (!to || typeof to !== 'string') return;
    if (!socket.data.roomId) return;

    const room = rooms.get(socket.data.roomId);
    if (!room || !room.users.has(to)) return;

    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('mic-state', ({ muted }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.muted = !!muted;
    socket.to(socket.data.roomId).emit('user-mic-state', { id: socket.id, muted: user.muted });
  });

  socket.on('speaking-state', ({ speaking }) => {
    if (!withinRateLimit(socket)) return;
    if (!socket.data.roomId) return;
    socket.to(socket.data.roomId).emit('user-speaking-state', { id: socket.id, speaking: !!speaking });
  });

  socket.on('screen-share-state', ({ sharing }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.sharingScreen = !!sharing;
    socket.to(socket.data.roomId).emit('user-screen-share-state', { id: socket.id, sharing: user.sharingScreen });
  });

  socket.on('leave-room', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });

  function handleLeave(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      room.users.delete(socket.id);
      socket.to(roomId).emit('user-left', { id: socket.id });
      cleanupEmptyRoom(roomId);
    }
    socket.leave(roomId);
    socket.data.roomId = null;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`ChatPatty rodando na porta ${PORT} [${NODE_ENV}]`);
});

module.exports = { app, server, io };

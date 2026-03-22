const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Room storage: { roomCode: { users: Map<socketId, { username, socketId }> } }
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  let currentRoom = null;
  let currentUsername = null;

  // Create a new room
  socket.on('create-room', ({ username }, callback) => {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    rooms.set(code, { users: new Map() });
    rooms.get(code).users.set(socket.id, { username, socketId: socket.id });

    socket.join(code);
    currentRoom = code;
    currentUsername = username;

    console.log(`[Room] ${username} created room ${code}`);
    callback({ success: true, roomCode: code });
  });

  // Join an existing room
  socket.on('join-room', ({ roomCode, username }, callback) => {
    const code = roomCode.toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      callback({ success: false, error: 'Room not found. Check the code and try again.' });
      return;
    }

    // Get existing users before adding new one
    const existingUsers = Array.from(room.users.values());

    room.users.set(socket.id, { username, socketId: socket.id });
    socket.join(code);
    currentRoom = code;
    currentUsername = username;

    // Notify existing users about the new participant
    socket.to(code).emit('user-joined', {
      socketId: socket.id,
      username
    });

    console.log(`[Room] ${username} joined room ${code} (${room.users.size} users)`);
    callback({ success: true, roomCode: code, existingUsers });
  });

  // WebRTC Signaling: relay offer
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', {
      from: socket.id,
      offer,
      username: currentUsername
    });
  });

  // WebRTC Signaling: relay answer
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', {
      from: socket.id,
      answer
    });
  });

  // WebRTC Signaling: relay ICE candidate
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  // Chat messages
  socket.on('chat-message', ({ message }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('chat-message', {
      username: currentUsername,
      message,
      timestamp: Date.now()
    });
  });

  // File sharing metadata
  socket.on('share-file', ({ fileName, fileSize, fileType, fileUrl }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('file-shared', {
      username: currentUsername,
      fileName,
      fileSize,
      fileType,
      fileUrl,
      timestamp: Date.now()
    });
  });

  // Screen share status
  socket.on('screen-share-started', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('user-screen-sharing', {
      socketId: socket.id,
      username: currentUsername
    });
  });

  socket.on('screen-share-stopped', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('user-stopped-screen-sharing', {
      socketId: socket.id,
      username: currentUsername
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(socket.id);

      socket.to(currentRoom).emit('user-left', {
        socketId: socket.id,
        username: currentUsername
      });

      // Clean up empty rooms
      if (room.users.size === 0) {
        rooms.delete(currentRoom);
        console.log(`[Room] Room ${currentRoom} deleted (empty)`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         MeetFlow Server Running          ║
  ║──────────────────────────────────────────║
  ║   Local:  http://localhost:${PORT}          ║
  ╚══════════════════════════════════════════╝
  `);
});

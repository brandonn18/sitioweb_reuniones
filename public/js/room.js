/* ═══════════════════════════════════════════
   MeetFlow — Conference Room Logic (WebRTC)
   ═══════════════════════════════════════════ */

// ── State ──
const socket = io();
const peers = new Map(); // socketId -> { pc: RTCPeerConnection, username, videoEl, tile }
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let isMicOn = true;
let isCameraOn = true;
let isChatOpen = false;
let unreadMessages = 0;
let roomStartTime = null;
let timerInterval = null;

// Session data
const username = sessionStorage.getItem('meetflow-username') || 'Guest';
const roomCode = sessionStorage.getItem('meetflow-room');
const role = sessionStorage.getItem('meetflow-role');

// STUN servers for NAT traversal
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// ── DOM References ──
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');
const localUsername = document.getElementById('local-username');
const localNoCam = document.getElementById('local-no-cam');
const localMicIndicator = document.getElementById('local-mic-indicator');
const headerRoomCode = document.getElementById('header-room-code');
const btnHeaderCopy = document.getElementById('btn-header-copy');
const participantCount = document.getElementById('participant-count');
const roomTimer = document.getElementById('room-timer');

const btnMic = document.getElementById('btn-mic');
const btnCamera = document.getElementById('btn-camera');
const btnScreen = document.getElementById('btn-screen');
const btnFile = document.getElementById('btn-file');
const btnChat = document.getElementById('btn-chat');
const btnLeave = document.getElementById('btn-leave');

const chatPanel = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');
const btnCloseChat = document.getElementById('btn-close-chat');
const chatBadge = document.getElementById('chat-badge');

const fileInput = document.getElementById('file-input');

const modalLeave = document.getElementById('modal-leave');
const btnCancelLeave = document.getElementById('btn-cancel-leave');
const btnConfirmLeave = document.getElementById('btn-confirm-leave');
const toastContainer = document.getElementById('toast-container');

// ══════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════

async function init() {
  if (!roomCode) {
    window.location.href = '/';
    return;
  }

  // Update UI
  headerRoomCode.textContent = roomCode;
  localUsername.textContent = username;

  // Get local media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    localVideo.srcObject = localStream;
  } catch (err) {
    console.warn('Could not get media:', err);
    try {
      // Try audio only
      localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true
      });
      localVideo.srcObject = localStream;
      isCameraOn = false;
      updateCameraUI();
    } catch (err2) {
      console.warn('Could not get any media:', err2);
      // Create an empty stream for signaling
      localStream = new MediaStream();
      isCameraOn = false;
      isMicOn = false;
      updateCameraUI();
      updateMicUI();
    }
  }

  // Join or create room via signaling
  if (role === 'creator') {
    socket.emit('create-room', { username }, (response) => {
      if (response.success) {
        // Room was already created from landing, but we need a fresh connection
        // The server will handle the duplicate code gracefully
        headerRoomCode.textContent = response.roomCode;
        sessionStorage.setItem('meetflow-room', response.roomCode);
        startTimer();
        showToast('info', `Sala ${response.roomCode} creada`);
      }
    });
  } else {
    socket.emit('join-room', { roomCode, username }, (response) => {
      if (response.success) {
        startTimer();
        showToast('info', `Te uniste a la sala ${roomCode}`);
        // Connect to existing users
        if (response.existingUsers && response.existingUsers.length > 0) {
          response.existingUsers.forEach((user) => {
            createPeerConnection(user.socketId, user.username, true);
          });
        }
      } else {
        showToast('warning', response.error || 'No se pudo unir a la sala');
        setTimeout(() => {
          window.location.href = '/';
        }, 2000);
      }
    });
  }

  updateVideoGridLayout();
  setupEventListeners();
  setupSocketListeners();
}

// ══════════════════════════════════════
// WEBRTC PEER CONNECTIONS
// ══════════════════════════════════════

function createPeerConnection(remoteSocketId, remoteUsername, initiator = false) {
  if (peers.has(remoteSocketId)) return;

  const pc = new RTCPeerConnection(rtcConfig);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  // Create video tile for remote user
  const { tile, videoEl } = createRemoteVideoTile(remoteSocketId, remoteUsername);

  peers.set(remoteSocketId, { pc, username: remoteUsername, videoEl, tile });

  // Handle incoming tracks
  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
    }
  };

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        to: remoteSocketId,
        candidate: event.candidate
      });
    }
  };

  // Connection state
  pc.onconnectionstatechange = () => {
    console.log(`Peer ${remoteUsername}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      showToast('warning', `Conexión perdida con ${remoteUsername}`);
    }
  };

  // If we are the initiator, create and send an offer
  if (initiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('offer', {
          to: remoteSocketId,
          offer: pc.localDescription
        });
      })
      .catch((err) => console.error('Error creating offer:', err));
  }

  updateVideoGridLayout();
  updateParticipantCount();
  return pc;
}

function createRemoteVideoTile(socketId, peerUsername) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${socketId}`;

  const videoEl = document.createElement('video');
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.id = `video-${socketId}`;

  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  overlay.innerHTML = `
    <span class="video-username">${peerUsername}</span>
    <div class="video-indicators">
      <span class="indicator indicator-mic" id="mic-${socketId}">
        <i class="fas fa-microphone"></i>
      </span>
    </div>
  `;

  const noCam = document.createElement('div');
  noCam.className = 'video-no-cam';
  noCam.id = `nocam-${socketId}`;
  noCam.style.display = 'none';
  noCam.innerHTML = `
    <div class="avatar-circle">
      <span style="font-size: 1.5rem; font-weight: 700;">${peerUsername.charAt(0).toUpperCase()}</span>
    </div>
  `;

  tile.appendChild(videoEl);
  tile.appendChild(noCam);
  tile.appendChild(overlay);
  videoGrid.appendChild(tile);

  return { tile, videoEl };
}

function removePeer(socketId) {
  const peer = peers.get(socketId);
  if (peer) {
    peer.pc.close();
    if (peer.tile) peer.tile.remove();
    peers.delete(socketId);
    updateVideoGridLayout();
    updateParticipantCount();
  }
}

// ══════════════════════════════════════
// SOCKET LISTENERS
// ══════════════════════════════════════

function setupSocketListeners() {
  // New user joined
  socket.on('user-joined', ({ socketId, username: peerUsername }) => {
    showToast('info', `${peerUsername} se unió a la reunión`);
    addSystemMessage(`${peerUsername} se unió`);
    // Don't initiate - wait for their offer
    // The new user will initiate connections to existing users
  });

  // Receive offer
  socket.on('offer', async ({ from, offer, username: peerUsername }) => {
    const pc = createPeerConnection(from, peerUsername, false);
    const peerData = peers.get(from);
    if (peerData) {
      try {
        await peerData.pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerData.pc.createAnswer();
        await peerData.pc.setLocalDescription(answer);
        socket.emit('answer', { to: from, answer: peerData.pc.localDescription });
      } catch (err) {
        console.error('Error handling offer:', err);
      }
    }
  });

  // Receive answer
  socket.on('answer', async ({ from, answer }) => {
    const peerData = peers.get(from);
    if (peerData) {
      try {
        await peerData.pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Error handling answer:', err);
      }
    }
  });

  // Receive ICE candidate
  socket.on('ice-candidate', async ({ from, candidate }) => {
    const peerData = peers.get(from);
    if (peerData) {
      try {
        await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    }
  });

  // User left
  socket.on('user-left', ({ socketId, username: peerUsername }) => {
    showToast('info', `${peerUsername} salió de la reunión`);
    addSystemMessage(`${peerUsername} salió`);
    removePeer(socketId);
  });

  // Chat message
  socket.on('chat-message', ({ username: senderName, message, timestamp }) => {
    addChatBubble(senderName, message, timestamp, false);
    if (!isChatOpen) {
      unreadMessages++;
      chatBadge.textContent = unreadMessages;
      chatBadge.style.display = 'flex';
    }
  });

  // File shared
  socket.on('file-shared', ({ username: senderName, fileName, fileSize, fileType, fileUrl }) => {
    addFileMessage(senderName, fileName, fileSize, fileUrl);
    showToast('info', `${senderName} compartió: ${fileName}`);
  });

  // Screen share notifications
  socket.on('user-screen-sharing', ({ socketId, username: peerUsername }) => {
    showToast('info', `${peerUsername} está compartiendo pantalla`);
  });

  socket.on('user-stopped-screen-sharing', ({ socketId }) => {
    // Visual updates handled by track replacement
  });
}

// ══════════════════════════════════════
// MEDIA CONTROLS
// ══════════════════════════════════════

function toggleMic() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  audioTracks.forEach((track) => {
    track.enabled = !track.enabled;
  });
  isMicOn = !isMicOn;
  updateMicUI();
}

function toggleCamera() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  videoTracks.forEach((track) => {
    track.enabled = !track.enabled;
  });
  isCameraOn = !isCameraOn;
  updateCameraUI();
}

async function toggleScreenShare() {
  if (isScreenSharing) {
    stopScreenShare();
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false
    });

    const screenTrack = screenStream.getVideoTracks()[0];

    // Replace video track in all peer connections
    peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(screenTrack);
      }
    });

    // Show screen share in local video
    localVideo.srcObject = screenStream;

    // When user stops sharing via browser UI
    screenTrack.onended = () => stopScreenShare();

    isScreenSharing = true;
    btnScreen.classList.add('active');
    socket.emit('screen-share-started');
    showToast('success', 'Compartiendo pantalla');
  } catch (err) {
    console.log('Screen share cancelled');
  }
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  // Restore camera track
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(videoTrack);
      }
    });
  }

  localVideo.srcObject = localStream;
  isScreenSharing = false;
  btnScreen.classList.remove('active');
  socket.emit('screen-share-stopped');
  showToast('info', 'Dejaste de compartir pantalla');
}

function shareFile() {
  fileInput.click();
}

function handleFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Max 50MB
  if (file.size > 50 * 1024 * 1024) {
    showToast('warning', 'El archivo es demasiado grande (máx. 50MB)');
    return;
  }

  // Create a local URL for the file
  const fileUrl = URL.createObjectURL(file);

  // Notify others via signaling
  socket.emit('share-file', {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    fileUrl: '' // URL is local only; for real sharing, you'd upload to a server
  });

  // Show in own chat
  addFileMessage('Tú', file.name, file.size, fileUrl);
  showToast('success', `Archivo compartido: ${file.name}`);

  // Reset input
  fileInput.value = '';
}

// ══════════════════════════════════════
// UI UPDATES
// ══════════════════════════════════════

function updateMicUI() {
  if (isMicOn) {
    btnMic.classList.remove('muted');
    btnMic.querySelector('i').className = 'fas fa-microphone';
    localMicIndicator.classList.remove('muted');
    localMicIndicator.querySelector('i').className = 'fas fa-microphone';
  } else {
    btnMic.classList.add('muted');
    btnMic.querySelector('i').className = 'fas fa-microphone-slash';
    localMicIndicator.classList.add('muted');
    localMicIndicator.querySelector('i').className = 'fas fa-microphone-slash';
  }
}

function updateCameraUI() {
  if (isCameraOn) {
    btnCamera.classList.remove('muted');
    btnCamera.querySelector('i').className = 'fas fa-video';
    localNoCam.style.display = 'none';
  } else {
    btnCamera.classList.add('muted');
    btnCamera.querySelector('i').className = 'fas fa-video-slash';
    localNoCam.style.display = 'flex';
  }
}

function updateVideoGridLayout() {
  const totalParticipants = peers.size + 1; // +1 for local
  videoGrid.setAttribute('data-count', Math.min(totalParticipants, 9));
}

function updateParticipantCount() {
  const total = peers.size + 1;
  participantCount.querySelector('span').textContent = total;
}

// ── Timer ──
function startTimer() {
  roomStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - roomStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    roomTimer.textContent = `${mins}:${secs}`;
  }, 1000);
}

// ══════════════════════════════════════
// CHAT
// ══════════════════════════════════════

function toggleChat() {
  isChatOpen = !isChatOpen;
  chatPanel.classList.toggle('open', isChatOpen);
  btnChat.classList.toggle('active', isChatOpen);

  if (isChatOpen) {
    unreadMessages = 0;
    chatBadge.style.display = 'none';
    chatInput.focus();

    // Remove empty state if messages exist
    const emptyState = chatMessages.querySelector('.chat-empty');
    if (emptyState && chatMessages.children.length > 1) {
      emptyState.remove();
    }
  }
}

function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message) return;

  socket.emit('chat-message', { message });
  addChatBubble('Tú', message, Date.now(), true);

  chatInput.value = '';
  chatInput.focus();
}

function addChatBubble(senderName, message, timestamp, isOutgoing) {
  // Remove empty state
  const emptyState = chatMessages.querySelector('.chat-empty');
  if (emptyState) emptyState.remove();

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;

  const time = new Date(timestamp);
  const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;

  bubble.innerHTML = `
    <div class="chat-bubble-name">${senderName}</div>
    <div>${escapeHtml(message)}</div>
    <div class="chat-bubble-time">${timeStr}</div>
  `;

  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const emptyState = chatMessages.querySelector('.chat-empty');
  if (emptyState) emptyState.remove();

  const msg = document.createElement('div');
  msg.className = 'chat-system';
  msg.textContent = text;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addFileMessage(senderName, fileName, fileSize, fileUrl) {
  const emptyState = chatMessages.querySelector('.chat-empty');
  if (emptyState) emptyState.remove();

  const sizeStr = formatFileSize(fileSize);

  const msg = document.createElement('div');
  msg.className = 'chat-file';
  msg.innerHTML = `
    <i class="fas fa-file-alt"></i>
    <div>
      <strong>${senderName}</strong> compartió un archivo<br>
      ${fileUrl ? `<a href="${fileUrl}" download="${fileName}">${fileName}</a>` : `<span>${fileName}</span>`}
      <span style="opacity:0.6; font-size:0.7rem;"> (${sizeStr})</span>
    </div>
  `;

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ══════════════════════════════════════
// TOAST NOTIFICATIONS
// ══════════════════════════════════════

function showToast(type, message) {
  const icons = {
    info: 'fa-info-circle',
    success: 'fa-check-circle',
    warning: 'fa-exclamation-triangle'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fas ${icons[type] || icons.info}"></i>
    <span>${message}</span>
  `;

  toastContainer.appendChild(toast);

  // Remove after animation
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// ══════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════

function setupEventListeners() {
  btnMic.addEventListener('click', toggleMic);
  btnCamera.addEventListener('click', toggleCamera);
  btnScreen.addEventListener('click', toggleScreenShare);
  btnFile.addEventListener('click', shareFile);
  btnChat.addEventListener('click', toggleChat);
  btnCloseChat.addEventListener('click', toggleChat);

  fileInput.addEventListener('change', handleFileSelected);

  // Chat
  btnSendChat.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  // Leave
  btnLeave.addEventListener('click', () => {
    modalLeave.style.display = 'flex';
  });

  btnCancelLeave.addEventListener('click', () => {
    modalLeave.style.display = 'none';
  });

  btnConfirmLeave.addEventListener('click', () => {
    leaveRoom();
  });

  modalLeave.addEventListener('click', (e) => {
    if (e.target === modalLeave) modalLeave.style.display = 'none';
  });

  // Copy room code
  btnHeaderCopy.addEventListener('click', () => {
    const code = headerRoomCode.textContent;
    navigator.clipboard.writeText(code).then(() => {
      showToast('success', '¡Código copiado!');
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toLowerCase()) {
      case 'm': toggleMic(); break;
      case 'v': toggleCamera(); break;
      case 's': toggleScreenShare(); break;
      case 'c': toggleChat(); break;
    }
  });

  // Before unload warning
  window.addEventListener('beforeunload', (e) => {
    e.preventDefault();
    e.returnValue = '';
  });
}

function leaveRoom() {
  // Stop all tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
  }

  // Close all peer connections
  peers.forEach(({ pc }) => pc.close());
  peers.clear();

  // Disconnect socket
  socket.disconnect();

  // Clear timer
  if (timerInterval) clearInterval(timerInterval);

  // Clear session
  sessionStorage.clear();

  // Navigate home
  window.location.href = '/';
}

// ══════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ══════════════════════════════════════
// START
// ══════════════════════════════════════

init();

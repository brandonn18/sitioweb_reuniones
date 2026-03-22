/* ═══════════════════════════════════════════
   MeetFlow — Landing Page Logic
   ═══════════════════════════════════════════ */

const socket = io();

// DOM Elements
const createUsernameInput = document.getElementById('create-username');
const joinUsernameInput = document.getElementById('join-username');
const joinCodeInput = document.getElementById('join-code');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const modalRoomCreated = document.getElementById('modal-room-created');
const roomCodeDisplay = document.getElementById('room-code-display');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnEnterRoom = document.getElementById('btn-enter-room');

let createdRoomCode = null;

// ── Create Room ──
btnCreate.addEventListener('click', () => {
  const username = createUsernameInput.value.trim();
  if (!username) {
    shakeInput(createUsernameInput);
    createUsernameInput.focus();
    return;
  }

  btnCreate.disabled = true;
  btnCreate.innerHTML = '<div class="spinner"></div><span>Creando...</span>';

  socket.emit('create-room', { username }, (response) => {
    if (response.success) {
      createdRoomCode = response.roomCode;
      roomCodeDisplay.textContent = response.roomCode;

      // Store session info
      sessionStorage.setItem('meetflow-username', username);
      sessionStorage.setItem('meetflow-room', response.roomCode);
      sessionStorage.setItem('meetflow-role', 'creator');

      // Show modal
      modalRoomCreated.style.display = 'flex';
    } else {
      alert('Error creating room. Please try again.');
    }

    btnCreate.disabled = false;
    btnCreate.innerHTML = '<i class="fas fa-rocket"></i><span>Crear Sala</span>';
  });
});

// ── Join Room ──
btnJoin.addEventListener('click', () => {
  const username = joinUsernameInput.value.trim();
  const code = joinCodeInput.value.trim().toUpperCase();

  if (!username) {
    shakeInput(joinUsernameInput);
    joinUsernameInput.focus();
    return;
  }
  if (!code || code.length < 4) {
    shakeInput(joinCodeInput);
    joinCodeInput.focus();
    return;
  }

  btnJoin.disabled = true;
  btnJoin.innerHTML = '<div class="spinner"></div><span>Uniéndose...</span>';

  // Disconnect from landing socket before going to room
  socket.disconnect();

  // Store session info
  sessionStorage.setItem('meetflow-username', username);
  sessionStorage.setItem('meetflow-room', code);
  sessionStorage.setItem('meetflow-role', 'joiner');

  // Navigate to room
  window.location.href = '/room.html';
});

// ── Enter Room (after creating) ──
btnEnterRoom.addEventListener('click', () => {
  socket.disconnect();
  window.location.href = '/room.html';
});

// ── Copy Code ──
btnCopyCode.addEventListener('click', () => {
  if (createdRoomCode) {
    navigator.clipboard.writeText(createdRoomCode).then(() => {
      btnCopyCode.innerHTML = '<i class="fas fa-check"></i><span>¡Copiado!</span>';
      setTimeout(() => {
        btnCopyCode.innerHTML = '<i class="fas fa-copy"></i><span>Copiar Código</span>';
      }, 2000);
    });
  }
});

// ── Input Shake Animation ──
function shakeInput(input) {
  const group = input.closest('.input-group');
  group.style.animation = 'shake 0.4s ease';
  group.style.borderColor = '#ef233c';
  setTimeout(() => {
    group.style.animation = '';
    group.style.borderColor = '';
  }, 500);
}

// Add shake keyframe
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
`;
document.head.appendChild(style);

// ── Enter key support ──
createUsernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnCreate.click();
});

joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

joinUsernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinCodeInput.focus();
});

// Auto-uppercase room code
joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase();
});

// Close modal on overlay click
modalRoomCreated.addEventListener('click', (e) => {
  if (e.target === modalRoomCreated) {
    modalRoomCreated.style.display = 'none';
  }
});

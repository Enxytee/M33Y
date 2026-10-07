const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Add a TURN server here too if connections fail on strict mobile networks.
];

let ws, pc, dataChannel;

const setupDiv = document.getElementById('setup');
const screenDiv = document.getElementById('screen');
const statusEl = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');
const hiddenInput = document.getElementById('hiddenInput');
const keyRow = document.getElementById('keyRow');

document.getElementById('connectBtn').onclick = connect;
document.getElementById('disconnectBtn').onclick = () => location.reload();
document.getElementById('keyboardBtn').onclick = () => {
  keyRow.classList.toggle('hidden');
  hiddenInput.focus();
};

function send(action) {
  if (dataChannel && dataChannel.readyState === 'open') dataChannel.send(JSON.stringify(action));
}

// ---- File transfer helpers (shared by send and receive, both directions) ----
const FILE_CHUNK_SIZE = 48 * 1024;

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function downloadBase64File(name, base64) {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function sendFilesToHost(files) {
  const transferBar = document.getElementById('transferBar');
  const statusEl = document.getElementById('transferStatus');
  if (!files.length) return;
  transferBar.classList.remove('hidden');
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    send({ type: 'file-start', name: file.name, size: file.size });
    for (let i = 0; i < base64.length; i += FILE_CHUNK_SIZE) {
      send({ type: 'file-chunk', data: base64.slice(i, i + FILE_CHUNK_SIZE) });
      statusEl.textContent = `Sending "${file.name}": ${Math.min(100, Math.round(((i + FILE_CHUNK_SIZE) / base64.length) * 100))}%`;
      await new Promise((r) => setTimeout(r, 0));
    }
    send({ type: 'file-end' });
  }
  statusEl.textContent = 'Sent.';
  setTimeout(() => transferBar.classList.add('hidden'), 3000);
}

function connectSignaling(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = reject;
  });
}

async function connect(opts) {
  const url = document.getElementById('serverUrl').value.trim();
  const code = (opts && opts.code) || document.getElementById('joinCode').value.trim();
  const password = (opts && opts.qrToken) ? undefined : document.getElementById('joinPassword').value;
  const qrToken = opts && opts.qrToken;
  if (!url || !code) {
    statusEl.textContent = 'Enter the code shown on the host computer.';
    return;
  }

  statusEl.textContent = 'Connecting...';
  try {
    ws = await connectSignaling(url);
  } catch {
    statusEl.textContent = 'Could not reach signaling server.';
    return;
  }
  const registerMsg = { type: 'register', code, role: 'viewer' };
  if (qrToken) registerMsg.qrToken = qrToken;
  else registerMsg.password = password;
  ws.send(JSON.stringify(registerMsg));

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate }));
  };
  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    setupDiv.classList.add('hidden');
    screenDiv.classList.remove('hidden');
  };
  pc.ondatachannel = (e) => {
    dataChannel = e.channel;
    setupIncomingFileReceiver();
    setupTouchControls();
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'offer') {
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    } else if (msg.type === 'ice-candidate') {
      try { await pc.addIceCandidate(msg.candidate); } catch {}
    } else if (msg.type === 'peer-left') {
      statusEl.textContent = 'Host disconnected.';
    } else if (msg.type === 'pending-approval') {
      statusEl.textContent = 'Waiting for the computer owner to accept your request...';
    } else if (msg.type === 'error') {
      statusEl.textContent = msg.message;
    }
  };

  statusEl.textContent = 'Waiting for host...';
}

// ---- Auto-connect when opened from a QR code (?code=...&qrToken=...) ----
(function autoConnectFromQr() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const qrToken = params.get('qrToken');
  if (code && qrToken) {
    // Hide the manual entry fields — scanning the QR code is all that's needed.
    document.getElementById('codeFieldGroup').style.display = 'none';
    document.getElementById('passwordFieldGroup').style.display = 'none';
    document.getElementById('connectBtn').style.display = 'none';
    statusEl.textContent = 'Connecting via QR code...';
    connect({ code, qrToken });
  }
})();

// ---- Receive files sent BY the host (drag/paste on the host's window) ----
let incomingFileFromHost = null;
function setupIncomingFileReceiver() {
  dataChannel.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const transferBar = document.getElementById('transferBar');
    const statusEl = document.getElementById('transferStatus');
    if (msg.type === 'file-start') {
      incomingFileFromHost = { name: msg.name, chunks: [] };
      transferBar.classList.remove('hidden');
      statusEl.textContent = `Receiving "${msg.name}"...`;
    } else if (msg.type === 'file-chunk') {
      if (incomingFileFromHost) incomingFileFromHost.chunks.push(msg.data);
    } else if (msg.type === 'file-end') {
      if (incomingFileFromHost) {
        downloadBase64File(incomingFileFromHost.name, incomingFileFromHost.chunks.join(''));
        statusEl.textContent = `✓ Downloaded "${incomingFileFromHost.name}"`;
        setTimeout(() => transferBar.classList.add('hidden'), 3000);
        incomingFileFromHost = null;
      }
    }
  });

  document.getElementById('fileInput').onchange = async (e) => {
    await sendFilesToHost(Array.from(e.target.files));
    e.target.value = '';
  };

  // Paste support where the browser allows it (e.g. an image copied in another app)
  document.addEventListener('paste', (e) => {
    const files = [];
    if (e.clipboardData && e.clipboardData.files) files.push(...e.clipboardData.files);
    if (files.length) sendFilesToHost(files);
  });
}

// ---------------- Touch trackpad + keyboard ----------------
function setupTouchControls() {
  let lastTouch = null;
  let moved = false;
  let twoFingerStart = null;

  remoteVideo.addEventListener('touchstart', (e) => {
    e.preventDefault();
    moved = false;
    if (e.touches.length === 1) {
      lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      twoFingerStart = { x: e.touches[0].clientY };
    }
  }, { passive: false });

  remoteVideo.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && lastTouch) {
      const t = e.touches[0];
      const dx = t.clientX - lastTouch.x;
      const dy = t.clientY - lastTouch.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      send({ type: 'mousemove-delta', dx: dx * 1.5, dy: dy * 1.5 });
      lastTouch = { x: t.clientX, y: t.clientY };
    } else if (e.touches.length === 2 && twoFingerStart) {
      const y = e.touches[0].clientY;
      const deltaY = y - twoFingerStart.x;
      send({ type: 'wheel', deltaY: -deltaY * 2 });
      twoFingerStart = { x: y };
      moved = true;
    }
  }, { passive: false });

  remoteVideo.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!moved) {
      if (e.changedTouches.length === 1 && (e.touches.length === 0)) {
        // was it a two-finger tap? approximate: handled separately below
        send({ type: 'mousedown', button: 0 });
        send({ type: 'mouseup', button: 0 });
      }
    }
    if (e.touches.length === 0) {
      lastTouch = null;
      twoFingerStart = null;
    }
  }, { passive: false });

  // two-finger tap = right click (detected via a quick second-finger touchstart with no movement)
  let twoFingerTapCandidate = false;
  remoteVideo.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) twoFingerTapCandidate = true;
  }, { passive: false });
  remoteVideo.addEventListener('touchend', (e) => {
    if (twoFingerTapCandidate && !moved && e.touches.length === 0) {
      send({ type: 'mousedown', button: 2 });
      send({ type: 'mouseup', button: 2 });
    }
    if (e.touches.length === 0) twoFingerTapCandidate = false;
  }, { passive: false });

  // On-screen keyboard row (special keys)
  keyRow.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.key;
      send({ type: 'keydown', code });
      send({ type: 'keyup', code });
    });
  });

  // Hidden input captures typed text from the phone's native keyboard
  let lastValue = '';
  hiddenInput.addEventListener('input', () => {
    const val = hiddenInput.value;
    if (val.length > lastValue.length) {
      send({ type: 'type-text', text: val.slice(lastValue.length) });
    } else if (val.length < lastValue.length) {
      const removed = lastValue.length - val.length;
      for (let i = 0; i < removed; i++) {
        send({ type: 'keydown', code: 'Backspace' });
        send({ type: 'keyup', code: 'Backspace' });
      }
    }
    lastValue = val;
    // keep the field short so it doesn't grow forever
    if (val.length > 200) {
      hiddenInput.value = '';
      lastValue = '';
    }
  });
}

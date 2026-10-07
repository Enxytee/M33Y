const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // If connections fail on strict networks (hotel/office wifi), add a TURN
  // server here, e.g.:
  // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
];

// The phone scans a QR code pointing at this hosted page, which auto-connects
// using the embedded code+qrToken — change this if you deploy the mobile
// viewer somewhere else.
const MOBILE_VIEWER_URL = 'https://m33y-1.onrender.com';

let ws, pc, dataChannel, localStream;
let role = null; // 'host' | 'viewer'
let hostScreenSize = null;
let qrToken = null;

// ---- UI wiring ----
const tabHost = document.getElementById('tabHost');
const tabViewer = document.getElementById('tabViewer');
const hostPanel = document.getElementById('hostPanel');
const viewerPanel = document.getElementById('viewerPanel');
const serverUrlInput = document.getElementById('serverUrl');
const hostCodeEl = document.getElementById('hostCode');
const sourceSelect = document.getElementById('sourceSelect');
const hostStatus = document.getElementById('hostStatus');
const lastActionEl = document.getElementById('lastAction');
const viewerStatus = document.getElementById('viewerStatus');
const joinCodeInput = document.getElementById('joinCode');
const setupDiv = document.getElementById('setup');
const viewerScreenDiv = document.getElementById('viewerScreen');
const remoteVideo = document.getElementById('remoteVideo');

tabHost.onclick = () => switchTab('host');
tabViewer.onclick = () => switchTab('viewer');
function switchTab(which) {
  tabHost.classList.toggle('active', which === 'host');
  tabViewer.classList.toggle('active', which === 'viewer');
  hostPanel.classList.toggle('hidden', which !== 'host');
  viewerPanel.classList.toggle('hidden', which !== 'viewer');
}

const sessionCode = Math.floor(100000 + Math.random() * 900000).toString();
hostCodeEl.textContent = sessionCode;

async function loadSources() {
  const sources = await window.electronAPI.getSources();
  sourceSelect.innerHTML = '';
  for (const s of sources) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sourceSelect.appendChild(opt);
  }
}
loadSources();

document.getElementById('startHost').onclick = () => startHost();
document.getElementById('startViewer').onclick = () => startViewer();
document.getElementById('disconnectBtn').onclick = () => location.reload();

function connectSignaling(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = (e) => reject(e);
  });
}

function newPeerConnection() {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  conn.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate }));
  };
  return conn;
}

// ---------------- HOST ----------------
async function startHost() {
  role = 'host';
  const url = serverUrlInput.value.trim();
  if (!url) return (hostStatus.textContent = 'Enter the signaling server URL first.');

  hostStatus.textContent = 'Connecting to signaling server...';
  try {
    ws = await connectSignaling(url);
  } catch {
    hostStatus.textContent = 'Could not reach signaling server.';
    return;
  }

  const hostPassword = document.getElementById('hostPassword').value;
  if (!hostPassword) return (hostStatus.textContent = 'Set an access password first.');

  qrToken = crypto.randomUUID();
  ws.send(JSON.stringify({ type: 'register', code: sessionCode, role: 'host', password: hostPassword, qrToken }));
  hostStatus.textContent = `Waiting for connection... your code is ${sessionCode}`;

  const deepLink = `${MOBILE_VIEWER_URL}?code=${encodeURIComponent(sessionCode)}&qrToken=${encodeURIComponent(qrToken)}`;
  try {
    const qrDataUrl = await window.electronAPI.generateQr(deepLink);
    document.getElementById('qrImage').src = qrDataUrl;
    document.getElementById('qrBlock').classList.remove('hidden');
  } catch (err) {
    console.error('QR generation failed:', err);
  }

  const sourceId = sourceSelect.value;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30,
      },
    },
  });

  pc = newPeerConnection();
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  dataChannel = pc.createDataChannel('control');
  setupHostDataChannel();

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'peer-joined') {
      hostStatus.textContent = 'Viewer joined, connecting...';
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    } else if (msg.type === 'answer') {
      await pc.setRemoteDescription(msg.sdp);
    } else if (msg.type === 'ice-candidate') {
      try { await pc.addIceCandidate(msg.candidate); } catch {}
    } else if (msg.type === 'peer-left') {
      hostStatus.textContent = 'Viewer disconnected.';
    } else if (msg.type === 'connect-request') {
      document.getElementById('approvalModal').classList.remove('hidden');
    } else if (msg.type === 'error') {
      hostStatus.textContent = msg.message;
    }
  };
}

document.getElementById('approveBtn').onclick = () => {
  document.getElementById('approvalModal').classList.add('hidden');
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'approve-connection' }));
};
document.getElementById('denyBtn').onclick = () => {
  document.getElementById('approvalModal').classList.add('hidden');
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'deny-connection' }));
};

let incomingFile = null;

function setupHostDataChannel() {
  dataChannel.onopen = async () => {
    hostStatus.textContent = 'Connected — being controlled remotely.';
    const size = await window.electronAPI.getScreenSize();
    dataChannel.send(JSON.stringify({ type: 'screen-size', ...size }));
  };
  dataChannel.onmessage = async (event) => {
    const action = JSON.parse(event.data);
    switch (action.type) {
      case 'clipboard':
        await window.electronAPI.setClipboardText(action.text);
        lastActionEl.textContent = `Received clipboard text (${new Date().toLocaleTimeString()})`;
        break;
      case 'file-start':
        incomingFile = { name: action.name, chunks: [] };
        lastActionEl.textContent = `Receiving ${action.name}...`;
        break;
      case 'file-chunk':
        if (incomingFile) incomingFile.chunks.push(action.data);
        break;
      case 'file-end': {
        if (incomingFile) {
          const base64 = incomingFile.chunks.join('');
          const dest = await window.electronAPI.saveIncomingFile(incomingFile.name, base64);
          lastActionEl.textContent = `✓ Received "${incomingFile.name}" → saved to Downloads/M33YdESK-received`;
          incomingFile = null;
        }
        break;
      }
      default:
        window.electronAPI.injectInput(action); // mouse / keyboard events
        lastActionEl.textContent = `Last received: ${action.type} (${new Date().toLocaleTimeString()})`;
    }
  };

  // ---- Send files TO the viewer: drag a file onto this window, or Ctrl+V paste ----
  async function sendFilesToViewer(files) {
    if (!files.length || !dataChannel || dataChannel.readyState !== 'open') return;
    await sendFilesOverChannel(dataChannel, files, (name, pct) => {
      lastActionEl.textContent = pct === 'done' ? `Sent "${name}" to viewer.` : `Sending "${name}" to viewer: ${pct}%`;
    });
  }

  document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    if (role !== 'host') return;
    sendFilesToViewer(Array.from(e.dataTransfer.files));
  });
  document.addEventListener('paste', (e) => {
    if (role !== 'host') return;
    const files = filesFromClipboardEvent(e);
    if (files.length) sendFilesToViewer(files);
  });
}

window.electronAPI.onInjectInputError((message) => {
  lastActionEl.textContent = `⚠ Mouse/keyboard error: ${message}`;
  lastActionEl.style.color = '#ff6b6b';
});

// ---------------- VIEWER ----------------
async function startViewer() {
  role = 'viewer';
  const url = serverUrlInput.value.trim();
  const code = joinCodeInput.value.trim();
  if (!url || !code) return (viewerStatus.textContent = 'Enter the server URL and the code.');

  viewerStatus.textContent = 'Connecting to signaling server...';
  try {
    ws = await connectSignaling(url);
  } catch {
    viewerStatus.textContent = 'Could not reach signaling server.';
    return;
  }

  const viewerPassword = document.getElementById('joinPassword').value;
  ws.send(JSON.stringify({ type: 'register', code, role: 'viewer', password: viewerPassword }));

  pc = newPeerConnection();
  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    setupDiv.classList.add('hidden');
    viewerScreenDiv.classList.remove('hidden');
  };
  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupViewerDataChannel();
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
      viewerStatus.textContent = 'Host disconnected.';
    } else if (msg.type === 'error') {
      viewerStatus.textContent = msg.message;
    }
  };

  viewerStatus.textContent = 'Waiting for host...';
}

let incomingFileFromHost = null;

function setupViewerDataChannel() {
  dataChannel.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const statusEl = document.getElementById('transferStatus');
    if (msg.type === 'screen-size') {
      hostScreenSize = { width: msg.width, height: msg.height };
    } else if (msg.type === 'file-start') {
      incomingFileFromHost = { name: msg.name, chunks: [] };
      statusEl.textContent = `Receiving "${msg.name}"...`;
    } else if (msg.type === 'file-chunk') {
      if (incomingFileFromHost) incomingFileFromHost.chunks.push(msg.data);
    } else if (msg.type === 'file-end') {
      if (incomingFileFromHost) {
        downloadBase64File(incomingFileFromHost.name, incomingFileFromHost.chunks.join(''));
        statusEl.textContent = `✓ Downloaded "${incomingFileFromHost.name}"`;
        setTimeout(() => (statusEl.textContent = ''), 3000);
        incomingFileFromHost = null;
      }
    }
  };

  function send(action) {
    if (dataChannel && dataChannel.readyState === 'open') dataChannel.send(JSON.stringify(action));
  }

  function toRemoteCoords(e) {
    const rect = remoteVideo.getBoundingClientRect();
    const vw = remoteVideo.videoWidth || rect.width;
    const vh = remoteVideo.videoHeight || rect.height;
    // account for letterboxing from object-fit: contain
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dispW = vw * scale, dispH = vh * scale;
    const offsetX = (rect.width - dispW) / 2, offsetY = (rect.height - dispH) / 2;
    const xInVideo = (e.clientX - rect.left - offsetX) / scale;
    const yInVideo = (e.clientY - rect.top - offsetY) / scale;
    const size = hostScreenSize || { width: vw, height: vh };
    return {
      x: (xInVideo / vw) * size.width,
      y: (yInVideo / vh) * size.height,
    };
  }

  remoteVideo.addEventListener('mousemove', (e) => {
    const { x, y } = toRemoteCoords(e);
    send({ type: 'mousemove', x, y });
  });
  remoteVideo.addEventListener('mousedown', (e) => send({ type: 'mousedown', button: e.button }));
  remoteVideo.addEventListener('mouseup', (e) => send({ type: 'mouseup', button: e.button }));
  remoteVideo.addEventListener('contextmenu', (e) => e.preventDefault());
  remoteVideo.addEventListener('wheel', (e) => send({ type: 'wheel', deltaY: e.deltaY }));

  remoteVideo.setAttribute('tabindex', '0');
  remoteVideo.focus();
  remoteVideo.addEventListener('keydown', (e) => { e.preventDefault(); send({ type: 'keydown', code: e.code }); });
  remoteVideo.addEventListener('keyup', (e) => { e.preventDefault(); send({ type: 'keyup', code: e.code }); });

  // ---- Clipboard sync: push my clipboard text to the host ----
  document.getElementById('clipboardBtn').onclick = async () => {
    const text = await window.electronAPI.getClipboardText();
    send({ type: 'clipboard', text });
    const el = document.getElementById('transferStatus');
    el.textContent = 'Clipboard sent.';
    setTimeout(() => (el.textContent = ''), 2000);
  };

  // ---- File transfer: send file(s) to the host — via the picker, drag-and-drop, or Ctrl+V paste ----
  const statusEl = document.getElementById('transferStatus');
  async function sendFilesToHost(files) {
    if (!files.length) return;
    await sendFilesOverChannel(dataChannel, files, (name, pct) => {
      statusEl.textContent = pct === 'done' ? `Sent "${name}".` : `Sending "${name}": ${pct}%`;
    });
    setTimeout(() => (statusEl.textContent = ''), 3000);
  }

  document.getElementById('fileInput').onchange = async (e) => {
    await sendFilesToHost(Array.from(e.target.files));
    e.target.value = '';
  };

  remoteVideo.addEventListener('dragover', (e) => e.preventDefault());
  remoteVideo.addEventListener('drop', (e) => {
    e.preventDefault();
    sendFilesToHost(Array.from(e.dataTransfer.files));
  });
  document.addEventListener('paste', (e) => {
    if (viewerScreenDiv.classList.contains('hidden')) return; // only while actively viewing
    const files = filesFromClipboardEvent(e);
    if (files.length) sendFilesToHost(files);
  });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---- Shared file transfer helpers (used by both host and viewer, both directions) ----
const FILE_CHUNK_SIZE = 48 * 1024; // base64 chars per chunk, keeps each message well under datachannel limits

async function sendFilesOverChannel(channel, files, onProgress) {
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    channel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size }));
    for (let i = 0; i < base64.length; i += FILE_CHUNK_SIZE) {
      channel.send(JSON.stringify({ type: 'file-chunk', data: base64.slice(i, i + FILE_CHUNK_SIZE) }));
      if (onProgress) onProgress(file.name, Math.min(100, Math.round(((i + FILE_CHUNK_SIZE) / base64.length) * 100)));
      await new Promise((r) => setTimeout(r, 0)); // let the data channel drain between chunks
    }
    channel.send(JSON.stringify({ type: 'file-end' }));
    if (onProgress) onProgress(file.name, 'done');
  }
}

// Base64 -> Blob -> triggers a normal browser download (used on the VIEWER side,
// which has no filesystem access of its own, to receive files sent by the host).
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

// Pulls real File objects out of a paste event — including a file copied in
// Windows Explorer / macOS Finder and pasted with Ctrl+V / Cmd+V, not just images.
function filesFromClipboardEvent(e) {
  const files = [];
  if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
    files.push(...e.clipboardData.files);
  } else if (e.clipboardData && e.clipboardData.items) {
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  return files;
}

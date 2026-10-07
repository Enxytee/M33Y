// Signaling server for the remote desktop app.
// It does NOT see your screen or control events — it only helps two peers
// find each other and exchange WebRTC connection info (offer/answer/ICE).
// Deploy this once (VPS, Render, Railway, etc.) and both your computers
// connect to it over the internet using its public URL.
//
// Two ways a viewer can join a room:
//  1. Password: viewer sends the matching password -> paired immediately, no host prompt.
//  2. QR token: viewer sends the one-time qrToken encoded in the QR code -> host gets a
//     'connect-request' and must explicitly approve-connection / deny-connection first.
//
// Per-connection state (joinedCode, joinedRole, isPending) is stored directly on each
// WebSocket object (not a closure variable) so that approving a pending viewer from the
// HOST's connection handler can correctly flip that viewer's OWN flags.

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// code -> { host, viewer, pendingViewer, password, qrToken }
const rooms = new Map();

function makeRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, viewer: null, pendingViewer: null, password: null, qrToken: null });
  return rooms.get(code);
}

function otherRole(role) {
  return role === 'host' ? 'viewer' : 'host';
}

wss.on('connection', (ws) => {
  ws.joinedCode = null;
  ws.joinedRole = null; // 'host' | 'viewer'
  ws.isPending = false; // true if this socket is a viewer awaiting host approval

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'register') {
      // { type:'register', code, role:'host'|'viewer', password? , qrToken? }
      const code = String(msg.code || '').trim();
      const role = msg.role === 'host' ? 'host' : 'viewer';
      if (!code) return;

      const room = makeRoom(code);

      if (role === 'host') {
        if (room.host) {
          ws.send(JSON.stringify({ type: 'error', message: 'A host is already connected with this code.' }));
          return;
        }
        room.password = String(msg.password || '');
        room.qrToken = msg.qrToken ? String(msg.qrToken) : null;
        room.host = ws;
        ws.joinedCode = code;
        ws.joinedRole = 'host';
        ws.send(JSON.stringify({ type: 'registered', role: 'host' }));

        if (room.viewer && room.viewer.readyState === WebSocket.OPEN) {
          room.viewer.send(JSON.stringify({ type: 'peer-joined' }));
          ws.send(JSON.stringify({ type: 'peer-joined' }));
        }
        return;
      }

      // --- viewer registering ---
      if (room.viewer) {
        ws.send(JSON.stringify({ type: 'error', message: 'A viewer is already connected with this code.' }));
        return;
      }

      const passwordOk = room.password && String(msg.password || '') === room.password;
      const qrOk = room.qrToken && msg.qrToken && String(msg.qrToken) === room.qrToken;

      if (passwordOk) {
        // Password matches -> pair immediately, no approval needed.
        room.viewer = ws;
        ws.joinedCode = code;
        ws.joinedRole = 'viewer';
        ws.send(JSON.stringify({ type: 'registered', role: 'viewer' }));
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify({ type: 'peer-joined' }));
          ws.send(JSON.stringify({ type: 'peer-joined' }));
        }
        return;
      }

      if (qrOk) {
        if (room.pendingViewer) {
          ws.send(JSON.stringify({ type: 'error', message: 'Another connection request is already pending host approval.' }));
          return;
        }
        room.pendingViewer = ws;
        ws.joinedCode = code;
        ws.isPending = true;
        ws.send(JSON.stringify({ type: 'pending-approval' }));
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify({ type: 'connect-request' }));
        }
        return;
      }

      ws.send(JSON.stringify({ type: 'error', message: 'Wrong password/QR code, or host not ready yet.' }));
      return;
    }

    if (msg.type === 'approve-connection' || msg.type === 'deny-connection') {
      // Only the host of this room may approve/deny.
      if (!ws.joinedCode || ws.joinedRole !== 'host' || !rooms.has(ws.joinedCode)) return;
      const room = rooms.get(ws.joinedCode);
      const pending = room.pendingViewer;
      if (!pending || pending.readyState !== WebSocket.OPEN) return;

      if (msg.type === 'approve-connection') {
        room.viewer = pending;
        room.pendingViewer = null;
        // Promote the pending viewer's own connection to a full, relay-eligible peer.
        pending.isPending = false;
        pending.joinedRole = 'viewer';
        pending.send(JSON.stringify({ type: 'registered', role: 'viewer' }));
        pending.send(JSON.stringify({ type: 'peer-joined' }));
        ws.send(JSON.stringify({ type: 'peer-joined' }));
      } else {
        pending.send(JSON.stringify({ type: 'error', message: 'Host denied the connection request.' }));
        room.pendingViewer = null;
      }
      return;
    }

    // Relay everything else (offer/answer/ice-candidate) to the other peer in the same room
    if (ws.joinedCode && rooms.has(ws.joinedCode) && !ws.isPending) {
      const room = rooms.get(ws.joinedCode);
      const peer = room[otherRole(ws.joinedRole)];
      if (peer && peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify(msg));
      }
    }
  });

  ws.on('close', () => {
    if (!ws.joinedCode || !rooms.has(ws.joinedCode)) return;
    const room = rooms.get(ws.joinedCode);

    if (ws.isPending) {
      if (room.pendingViewer === ws) room.pendingViewer = null;
      return;
    }

    if (!ws.joinedRole) return;
    const peer = room[otherRole(ws.joinedRole)];
    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify({ type: 'peer-left' }));
    }
    room[ws.joinedRole] = null;
    if (!room.host && !room.viewer && !room.pendingViewer) rooms.delete(ws.joinedCode);
    else if (ws.joinedRole === 'host') {
      room.password = null;
      room.qrToken = null;
    }
  });
});

console.log(`Signaling server running on ws://0.0.0.0:${PORT}`);

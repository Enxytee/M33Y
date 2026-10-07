const { spawn } = require('child_process');
const WebSocket = require('ws');

const server = spawn('node', ['server.js'], { cwd: __dirname });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d.toString()));
server.stderr.on('data', (d) => (serverLog += d.toString()));

setTimeout(() => {
  const host = new WebSocket('ws://localhost:8080');
  const viewerWrong = new WebSocket('ws://localhost:8080');
  const viewerRight = new WebSocket('ws://localhost:8080');
  const results = [];

  host.on('open', () => host.send(JSON.stringify({ type: 'register', code: '999999', role: 'host', password: 'secret123' })));
  host.on('message', (m) => results.push('HOST got: ' + m.toString()));

  viewerWrong.on('open', () =>
    setTimeout(() => viewerWrong.send(JSON.stringify({ type: 'register', code: '999999', role: 'viewer', password: 'wrongpass' })), 300)
  );
  viewerWrong.on('message', (m) => results.push('VIEWER(wrong pass) got: ' + m.toString()));

  viewerRight.on('open', () =>
    setTimeout(() => viewerRight.send(JSON.stringify({ type: 'register', code: '999999', role: 'viewer', password: 'secret123' })), 700)
  );
  viewerRight.on('message', (m) => results.push('VIEWER(correct pass) got: ' + m.toString()));

  setTimeout(() => {
    console.log(results.join('\n'));
    console.log('--- server log ---');
    console.log(serverLog);
    server.kill('SIGKILL');
    process.exit(0);
  }, 1500);
}, 500);

// hard safety net so this never hangs the sandbox
setTimeout(() => {
  try { server.kill('SIGKILL'); } catch {}
  process.exit(1);
}, 4000);

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;
let nut; // lazy-loaded (native module)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Needed so the renderer can use navigator.mediaDevices.getUserMedia
      // with Electron's desktopCapturer source ids.
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- List available screens/windows to share ----
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 300, height: 180 } });
  return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

// ---- QR code for the mobile viewer (no typing needed on the phone) ----
ipcMain.handle('generate-qr', async (_evt, text) => {
  const QRCode = require('qrcode');
  return QRCode.toDataURL(text, { width: 260, margin: 1 });
});

ipcMain.handle('get-screen-size', () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { width, height };
});

// ---- Clipboard sync ----
ipcMain.handle('get-clipboard-text', () => clipboard.readText());
ipcMain.handle('set-clipboard-text', (_evt, text) => clipboard.writeText(text || ''));

// ---- Incoming file transfer (saved to this machine's Downloads folder) ----
ipcMain.handle('save-incoming-file', (_evt, { name, base64 }) => {
  const dir = path.join(os.homedir(), 'Downloads', 'M33YdESK-received');
  fs.mkdirSync(dir, { recursive: true });
  const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest = path.join(dir, safeName);
  fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
  return dest;
});

// ---- Input injection (runs on the HOST machine, driven by the viewer's events) ----
async function getNut() {
  if (!nut) {
    nut = require('@nut-tree-fork/nut-js');
    nut.mouse.config.autoDelayMs = 0;
    nut.keyboard.config.autoDelayMs = 0;
  }
  return nut;
}

// Minimal browser KeyboardEvent.code -> nut-js Key map (extend as needed)
const KEY_MAP = {};
function buildKeyMap(Key) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const ch of letters) KEY_MAP[`Key${ch}`] = Key[ch];
  for (let i = 0; i <= 9; i++) KEY_MAP[`Digit${i}`] = Key[`Num${i}`];
  Object.assign(KEY_MAP, {
    Space: Key.Space, Enter: Key.Enter, Backspace: Key.Backspace, Tab: Key.Tab,
    Escape: Key.Escape, ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
    ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
    AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
    ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
    Delete: Key.Delete, Home: Key.Home, End: Key.End,
    PageUp: Key.PageUp, PageDown: Key.PageDown, MetaLeft: Key.LeftSuper, MetaRight: Key.RightSuper,
    Period: Key.Period, Comma: Key.Comma, Slash: Key.Slash, Semicolon: Key.Semicolon,
    Minus: Key.Minus, Equal: Key.Equal, BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket,
  });
}

ipcMain.handle('inject-input', async (_evt, action) => {
  try {
    const { mouse, keyboard, Button, Key, straightTo } = await getNut();
    if (Object.keys(KEY_MAP).length === 0) buildKeyMap(Key);

    switch (action.type) {
      case 'mousemove':
        await mouse.setPosition({ x: Math.round(action.x), y: Math.round(action.y) });
        break;
      case 'mousemove-delta': {
        // used by touch/trackpad-style input (mobile): move relative to current position
        const pos = await mouse.getPosition();
        await mouse.setPosition({
          x: Math.round(pos.x + action.dx),
          y: Math.round(pos.y + action.dy),
        });
        break;
      }
      case 'type-text':
        // used for mobile on-screen keyboard: types a whole string at once
        if (typeof action.text === 'string' && action.text.length) {
          await keyboard.type(action.text);
        }
        break;
      case 'mousedown':
        await mouse.pressButton(action.button === 2 ? Button.RIGHT : Button.LEFT);
        break;
      case 'mouseup':
        await mouse.releaseButton(action.button === 2 ? Button.RIGHT : Button.LEFT);
        break;
      case 'wheel':
        if (action.deltaY > 0) await mouse.scrollDown(Math.min(20, Math.abs(Math.round(action.deltaY / 20)) || 1));
        else await mouse.scrollUp(Math.min(20, Math.abs(Math.round(action.deltaY / 20)) || 1));
        break;
      case 'keydown': {
        const k = KEY_MAP[action.code];
        if (k !== undefined) await keyboard.pressKey(k);
        break;
      }
      case 'keyup': {
        const k = KEY_MAP[action.code];
        if (k !== undefined) await keyboard.releaseKey(k);
        break;
      }
    }
  } catch (err) {
    console.error('inject-input error:', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-input-error', err.message);
    }
  }
});

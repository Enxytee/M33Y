const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  injectInput: (action) => ipcRenderer.invoke('inject-input', action),
  getClipboardText: () => ipcRenderer.invoke('get-clipboard-text'),
  setClipboardText: (text) => ipcRenderer.invoke('set-clipboard-text', text),
  saveIncomingFile: (name, base64) => ipcRenderer.invoke('save-incoming-file', { name, base64 }),
  onInjectInputError: (callback) => ipcRenderer.on('inject-input-error', (_e, message) => callback(message)),
  generateQr: (text) => ipcRenderer.invoke('generate-qr', text),
});

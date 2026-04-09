const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Bot control
  startBot: (mode, config) => ipcRenderer.invoke('bot:start', { mode, config }),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  isBotRunning: () => ipcRenderer.invoke('bot:isRunning'),

  // Bot events
  onBotLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bot:log', handler);
    return () => ipcRenderer.removeListener('bot:log', handler);
  },
  onBotStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bot:status', handler);
    return () => ipcRenderer.removeListener('bot:status', handler);
  },
  onBotStarted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bot:started', handler);
    return () => ipcRenderer.removeListener('bot:started', handler);
  },
  onBotStopped: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bot:stopped', handler);
    return () => ipcRenderer.removeListener('bot:stopped', handler);
  },
  onChromeNotFound: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bot:chrome-not-found', handler);
    return () => ipcRenderer.removeListener('bot:chrome-not-found', handler);
  },

  // Account verification
  verifyAccount: (exchange, email) => ipcRenderer.invoke('verify:start', { exchange, email }),
  cancelVerify: (exchange) => ipcRenderer.invoke('verify:cancel', { exchange }),
  checkCookies: (exchange, email) => ipcRenderer.invoke('verify:checkCookies', { exchange, email }),

  onVerifyStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('verify:status', handler);
    return () => ipcRenderer.removeListener('verify:status', handler);
  },
  onVerifyResult: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('verify:result', handler);
    return () => ipcRenderer.removeListener('verify:result', handler);
  },
  onVerifyLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('verify:log', handler);
    return () => ipcRenderer.removeListener('verify:log', handler);
  },

  // Config
  readConfig: () => ipcRenderer.invoke('config:read'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getVersion: () => ipcRenderer.invoke('app:version'),
  fetchBtcPrice: () => ipcRenderer.invoke('btc:price'),
});

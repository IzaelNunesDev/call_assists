const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Window Controls ──────────────────────────────────────
  dragWindow: (pos) => ipcRenderer.send('window:drag', pos),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  getPosition: () => ipcRenderer.invoke('window:get-position'),

  // ── Settings ──────────────────────────────────────────────
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  // ── Protection ────────────────────────────────────────────
  toggleProtection: (enabled) => ipcRenderer.invoke('protection:toggle', enabled),

  // ── Whisper Setup & Transcrição ───────────────────────────
  setupWhisper: (data) => ipcRenderer.invoke('whisper:setup', data),
  onDownloadProgress: (cb) => {
    const handler = (_, msg) => cb(msg);
    ipcRenderer.on('download:progress', handler);
    return () => ipcRenderer.removeListener('download:progress', handler);
  },
  onTranscriptChunk: (cb) => {
    const handler = (_, text) => cb(text);
    ipcRenderer.on('transcribe:chunk', handler);
    return () => ipcRenderer.removeListener('transcribe:chunk', handler);
  },

  // ── AI Chat (Gemini streaming) ────────────────────────────
  sendChat: (data) => ipcRenderer.invoke('chat:send', data),
  onChatChunk: (cb) => {
    const handler = (_, chunk) => cb(chunk);
    ipcRenderer.on('chat:stream-chunk', handler);
    return () => ipcRenderer.removeListener('chat:stream-chunk', handler);
  },
  onChatDone: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('chat:stream-done', handler);
    return () => ipcRenderer.removeListener('chat:stream-done', handler);
  },

  // ── Captura de Áudio do Sistema ───────────────────────────
  getDesktopSources: () => ipcRenderer.invoke('desktop:get-sources'),
  startCapture: (data) => ipcRenderer.invoke('capture:start', data),
  stopCapture: () => ipcRenderer.invoke('capture:stop'),
  sendAudioChunk: (buffer, sampleRate, language) =>
    ipcRenderer.send('audio:pcm-chunk', { buffer, sampleRate, language }),

  // ── Screenshot ────────────────────────────────────────────
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),

  // ── Compressão via IA ─────────────────────────────────────
  aiCompress: (data) => ipcRenderer.invoke('ai:compress', data),

  // ── Histórico de Transcrições ─────────────────────────────
  saveTranscriptHistory: (data) => ipcRenderer.invoke('history:save', data),
  openHistoryFolder: () => ipcRenderer.invoke('history:open-folder'),

  // ── Summary ───────────────────────────────────────────────
  generateSummary: (data) => ipcRenderer.invoke('summary:generate', data),

  // ── Global Shortcuts ──────────────────────────────────────
  onShortcut: (name, cb) => {
    const handler = () => cb();
    ipcRenderer.on(`shortcut:${name}`, handler);
    return () => ipcRenderer.removeListener(`shortcut:${name}`, handler);
  },
});

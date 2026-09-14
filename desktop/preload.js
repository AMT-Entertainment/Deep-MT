const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepmt', {
  // tags / engines
  getEngines: () => ipcRenderer.send('ollama:tags'),
  onEngines: (cb) => ipcRenderer.on('ollama:tags:result', (_e, p) => cb(p)),

  // Chat
  chatSend: (messages, model) => ipcRenderer.send('chat:send', { messages, model }),
  onChatDelta: (cb) => ipcRenderer.on('chat:delta', (_e, p) => cb(p)),
  onChatEnd: (cb) => ipcRenderer.on('chat:end', (_e, p) => cb(p)),
  chatStop: () => ipcRenderer.send('chat:delta:stop'),

  // [MT] agent loop
  mtGoal: (req) => ipcRenderer.send('mt:goal', req),
  mtApprove: (ok) => ipcRenderer.send('mt:approve', ok),
  mtStop: () => ipcRenderer.send('mt:stop'),
  onMtEvent: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('mt:event', h);
    return () => ipcRenderer.removeListener('mt:event', h);
  },
  onMtEnd: (cb) => ipcRenderer.on('mt:end', (_e, p) => cb(p)),
  onMtAllStart: (cb) => ipcRenderer.on('mt:all-start', (_e) => cb()),

  // TAKE OVER
  takeStart: (req) => ipcRenderer.send('take:start', req),
  takeApprove: (ok) => ipcRenderer.send('take:approve', ok),
  takeStop: () => ipcRenderer.send('take:stop'),
  onTakeEvent: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('take:event', h);
    return () => ipcRenderer.removeListener('take:event', h);
  },
  onTakeEnd: (cb) => ipcRenderer.on('take:end', (_e, p) => cb(p)),

  quit: () => ipcRenderer.send('app:quit'),
});
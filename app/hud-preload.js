// The floating recording panel (REC lamp, timer, PAUSE, STOP). It can only ask to pause, resume or stop.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hud', {
  stop: () => ipcRenderer.send('hud:stop'),
  pause: () => ipcRenderer.send('hud:pause'),
  mark: () => ipcRenderer.send('hud:mark'),
  onMarked: cb => ipcRenderer.on('hud:marked', (_e, n) => cb(Number(n) || 0)),
  onPaused: cb => ipcRenderer.on('hud:paused', (_e, paused, recordedMs) => cb(!!paused, Number(recordedMs) || 0)),
});

// The floating recording panel (REC lamp, timer, mic meter, MARK, RETAKE, PAUSE, STOP). It can only ask to mark, discard the take, pause, resume or stop.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hud', {
  stop: () => ipcRenderer.send('hud:stop'),
  pause: () => ipcRenderer.send('hud:pause'),
  mark: () => ipcRenderer.send('hud:mark'),
  discard: () => ipcRenderer.send('hud:discard'),
  onRetake: cb => ipcRenderer.on('hud:retake', (_e, n) => cb(Number(n) || 0)),
  onMarked: cb => ipcRenderer.on('hud:marked', (_e, n) => cb(Number(n) || 0)),
  onLevel: cb => ipcRenderer.on('hud:level', (_e, v) => cb(Number(v) || 0)),
  onPaused: cb => ipcRenderer.on('hud:paused', (_e, paused, recordedMs) => cb(!!paused, Number(recordedMs) || 0)),
});

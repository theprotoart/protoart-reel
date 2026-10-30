// The floating recording panel (REC lamp, timer, STOP). It can only ask to stop the recording.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hud', { stop: () => ipcRenderer.send('hud:stop') });

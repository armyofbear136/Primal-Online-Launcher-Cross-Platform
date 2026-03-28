'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  selectChannel: (channelId) => ipcRenderer.invoke('launcher:selectChannel', channelId),
  launch:        ()           => ipcRenderer.invoke('game:launch'),
  retry:         ()           => ipcRenderer.invoke('launcher:retry'),
  enableAI:      ()           => ipcRenderer.invoke('launcher:enableAI'),
  getAISupported: ()          => ipcRenderer.invoke('launcher:aiSupported'),
  close:         ()           => ipcRenderer.invoke('window:close'),
  minimize:      ()           => ipcRenderer.invoke('window:minimize'),
  openUrl:       (url)        => ipcRenderer.invoke('shell:openUrl', url),

  onStatus:       (cb) => ipcRenderer.on('status',       (_, p) => cb(p)),
  onAnnouncement: (cb) => ipcRenderer.on('announcement', (_, p) => cb(p)),
  onVersion:      (cb) => ipcRenderer.on('version',      (_, p) => cb(p)),
  onAIReady:      (cb) => ipcRenderer.on('ai-ready',     (_, p) => cb(p)),
  onAIStatus:     (cb) => ipcRenderer.on('ai-status',    (_, p) => cb(p)),
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  // Launcher flow
  selectChannel:  (channelId) => ipcRenderer.invoke('launcher:selectChannel', channelId),
  launch:         ()           => ipcRenderer.invoke('game:launch'),
  retry:          ()           => ipcRenderer.invoke('launcher:retry'),
  downloadGame:   ()           => ipcRenderer.invoke('launcher:downloadGame'),
  close:          ()           => ipcRenderer.invoke('window:close'),
  minimize:       ()           => ipcRenderer.invoke('window:minimize'),
  openUrl:        (url)        => ipcRenderer.invoke('shell:openUrl', url),

  // AI
  enableAI:       ()           => ipcRenderer.invoke('launcher:enableAI'),
  getAISupported: ()           => ipcRenderer.invoke('launcher:aiSupported'),

  // Preferences
  getPrefs:       ()           => ipcRenderer.invoke('prefs:get'),
  setPrefs:       (patch)      => ipcRenderer.invoke('prefs:set', patch),

  // Push events main → renderer
  onStatus:       (cb) => ipcRenderer.on('status',       (_, p) => cb(p)),
  onAnnouncement: (cb) => ipcRenderer.on('announcement', (_, p) => cb(p)),
  onVersion:      (cb) => ipcRenderer.on('version',      (_, p) => cb(p)),
  onAIStatus:     (cb) => ipcRenderer.on('ai-status',    (_, p) => cb(p)),
  onAIReady:      (cb) => ipcRenderer.on('ai-ready',     (_, p) => cb(p)),
  onPrefs:        (cb) => ipcRenderer.on('prefs',        (_, p) => cb(p)),
});

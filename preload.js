// preload.js — contextBridge between renderer (index.html) and main process
// Runs with Node access but exposes only a narrow typed API to the renderer.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  // Kick off the full sequence: check → download game → download AI → start AI → ready
  start: () => ipcRenderer.invoke('launcher:start'),

  // Launch the game executable, then close the launcher
  launch: () => ipcRenderer.invoke('game:launch'),

  // Frameless window controls
  close:    () => ipcRenderer.invoke('window:close'),
  minimize: () => ipcRenderer.invoke('window:minimize'),

  // Push events from main → renderer
  // { phase, message, progress? }
  onStatus:  (cb) => ipcRenderer.on('status',   (_, p) => cb(p)),
  // { model } — fired when PHOBOS-Lite is up and healthy
  onAIReady: (cb) => ipcRenderer.on('ai-ready', (_, p) => cb(p)),
});

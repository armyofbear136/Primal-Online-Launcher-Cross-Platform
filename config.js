// config.js — single source of truth for all launcher constants
// Nothing else should hardcode URLs, ports, or paths.

'use strict';

const path = require('path');
const os = require('os');

// ─── Game update URLs ────────────────────────────────────────────────────────
const GAME_RELEASE_BASE = 'https://github.com/armyofbear136/Primal-Online-Client-Stable/releases/download/v0.0.2a-vn';
const GAME_DOWNLOAD_BASE = 'https://github.com/armyofbear136/Primal-Online-Client-Stable/releases/download/v0.0.2a';

exports.GAME_VERSION_URL  = `${GAME_RELEASE_BASE}/version.txt`;
exports.GAME_DOWNLOAD_URL = `${GAME_DOWNLOAD_BASE}/PO_Alpha_Stable_PC.zip`;

// ─── Local filesystem paths ──────────────────────────────────────────────────
// rootPath = directory where the launcher executable lives (or cwd in dev)
const rootPath = process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();

exports.ROOT_PATH       = rootPath;
exports.VERSION_FILE    = path.join(rootPath, 'version.txt');
exports.GAME_ZIP        = path.join(rootPath, 'PO_Alpha_Stable_PC.zip');
exports.GAME_DIR        = path.join(rootPath, 'Primal Online');

// Platform-aware game executable
exports.GAME_EXE = (() => {
  switch (process.platform) {
    case 'win32':  return path.join(rootPath, 'Primal Online', 'PO_Alpha_Stable.exe');
    case 'darwin': return path.join(rootPath, 'Primal Online', 'PO_Alpha_Stable.app', 'Contents', 'MacOS', 'PO_Alpha_Stable');
    default:       return path.join(rootPath, 'Primal Online', 'PO_Alpha_Stable');
  }
})();

// ─── PHOBOS-Lite config ──────────────────────────────────────────────────────
// Port PHOBOS-Lite will serve on. Written to phobos-provider.json for the game.
exports.PHOBOS_PORT = 52690;

// Health endpoint — PHOBOS-Lite exposes GET /health → { status: 'ok', model: '...' }
exports.PHOBOS_HEALTH_URL = `http://127.0.0.1:${exports.PHOBOS_PORT}/health`;

// Provider config file — game reads this at startup
exports.PHOBOS_PROVIDER_FILE = path.join(rootPath, 'phobos-provider.json');

// PHOBOS-Lite binary name per platform
exports.PHOBOS_BINARY = (() => {
  switch (process.platform) {
    case 'win32':  return path.join(rootPath, 'phobos-lite', 'phobos-lite.exe');
    case 'darwin': return path.join(rootPath, 'phobos-lite', 'phobos-lite');
    default:       return path.join(rootPath, 'phobos-lite', 'phobos-lite');
  }
})();

// PHOBOS-Lite model download base (Hugging Face or Autarch CDN — change as needed)
exports.PHOBOS_MODEL_BASE_URL = 'https://huggingface.co/autarch-industries/primal-online-models/resolve/main';

// ─── PHOBOS-Lite model catalogue ─────────────────────────────────────────────
//
// Selection logic (applied by phobos-lite at startup, not the launcher):
//   1. Enumerate hardware devices, exclude the primary game GPU
//   2. Find highest-scoring available device (CUDA > Metal > Vulkan > CPU)
//   3. Walk catalogue top-to-bottom, pick first model whose minVramMB fits
//
// The launcher only needs this catalogue to drive the download step and to
// know what to tell the user. phobos-lite does its own hardware probe at
// runtime and may override if the initial pick fails.
//
// vramClass values: 'gpu-high' | 'gpu-mid' | 'gpu-low' | 'igpu' | 'cpu'
// These correspond to phobos-lite's hardware scoring tiers.

exports.PHOBOS_MODEL_CATALOGUE = [
  {
    id: 'gemma-3-4b-it-q4',
    displayName: 'Gemma 3 4B (Q4_K_M)',
    filename: 'gemma-3-4b-it-q4_k_m.gguf',
    minVramMB: 3200,
    vramClass: 'gpu-mid',
    contextLength: 8192,
    description: 'Primary model — best quality/speed for dedicated iGPU or secondary GPU',
  },
  {
    id: 'gemma-3-1b-it-q8',
    displayName: 'Gemma 3 1B (Q8)',
    filename: 'gemma-3-1b-it-q8_0.gguf',
    minVramMB: 1400,
    vramClass: 'igpu',
    contextLength: 4096,
    description: 'Fallback — runs on integrated graphics or weak secondary GPU',
  },
  {
    id: 'gemma-3-1b-it-q4',
    displayName: 'Gemma 3 1B (Q4_K_M)',
    filename: 'gemma-3-1b-it-q4_k_m.gguf',
    minVramMB: 0,
    vramClass: 'cpu',
    contextLength: 4096,
    description: 'CPU fallback — always runnable, lower quality',
  },
];

// How long to wait for PHOBOS health check before giving up (ms)
exports.PHOBOS_HEALTH_TIMEOUT_MS = 60_000;
exports.PHOBOS_HEALTH_POLL_MS    = 1_000;

// main.js — Electron main process
// Owns: window lifecycle, game update pipeline, PHOBOS-Lite child process

'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const os     = require('os');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const cfg = require('./config');

// ─── Globals ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let phobosProc = null;   // PHOBOS-Lite child process handle
let phobosHealthTimer = null;

const isDev = process.argv.includes('--dev');

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    resizable: false,
    frame: false,           // frameless — renderer draws its own chrome
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),  // flat layout — preload.js is at root
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  stopPhobos();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { stopPhobos(); });

// ─── IPC surface ─────────────────────────────────────────────────────────────
// Renderer calls these via contextBridge (preload.js).
// All state flows renderer → main → renderer via ipcMain/send.

ipcMain.handle('launcher:start', async () => {
  try {
    await runLaunchSequence();
  } catch (err) {
    send('status', { phase: 'error', message: err.message });
  }
});

ipcMain.handle('window:close',    () => { app.quit(); });
ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); });

// ─── Status helper ────────────────────────────────────────────────────────────
// phase: 'check' | 'download-game' | 'download-phobos' | 'starting-ai' | 'ready' | 'error'
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ─── Main launch sequence ─────────────────────────────────────────────────────
async function runLaunchSequence() {
  // 1. Check / install game
  send('status', { phase: 'check', message: 'Checking for updates…' });
  await ensureGame();

  // 2. Ensure PHOBOS-Lite binary exists (download if missing)
  send('status', { phase: 'check-ai', message: 'Checking AI module…' });
  await ensurePhobosLite();

  // 3. Start PHOBOS-Lite
  send('status', { phase: 'starting-ai', message: 'Starting AI engine…' });
  await startPhobos();

  // 4. Ready
  send('status', { phase: 'ready', message: 'Ready' });
}

// ─── Game update logic ────────────────────────────────────────────────────────
async function ensureGame() {
  const localVersion = readLocalVersion();

  let onlineVersion;
  try {
    onlineVersion = await fetchText(cfg.GAME_VERSION_URL);
    onlineVersion = onlineVersion.trim();
  } catch {
    // Network unavailable — if game exists, let it run anyway
    if (fs.existsSync(cfg.GAME_EXE)) return;
    throw new Error('No network and no local game installation found.');
  }

  if (!localVersion || localVersion !== onlineVersion) {
    await downloadGame(onlineVersion);
  }
}

function readLocalVersion() {
  try { return fs.readFileSync(cfg.VERSION_FILE, 'utf8').trim(); }
  catch { return null; }
}

async function downloadGame(version) {
  send('status', { phase: 'download-game', message: 'Downloading game…', progress: 0 });

  await downloadFile(cfg.GAME_DOWNLOAD_URL, cfg.GAME_ZIP, (progress) => {
    send('status', { phase: 'download-game', message: 'Downloading game…', progress });
  });

  send('status', { phase: 'download-game', message: 'Extracting…', progress: 100 });

  // Extract
  const zip = new AdmZip(cfg.GAME_ZIP);
  zip.extractAllTo(cfg.ROOT_PATH, true);
  fs.unlinkSync(cfg.GAME_ZIP);

  fs.writeFileSync(cfg.VERSION_FILE, version, 'utf8');
}

// ─── PHOBOS-Lite binary ───────────────────────────────────────────────────────
async function ensurePhobosLite() {
  if (fs.existsSync(cfg.PHOBOS_BINARY)) return;

  // Determine which binary to download based on platform + arch
  const binaryUrl = getPhobosLiteBinaryUrl();
  if (!binaryUrl) {
    // No binary available for this platform yet — silently skip AI
    send('status', { phase: 'check-ai', message: 'AI module not available for this platform — skipping.' });
    return;
  }

  const binaryDir = path.dirname(cfg.PHOBOS_BINARY);
  fs.mkdirSync(binaryDir, { recursive: true });

  send('status', { phase: 'download-phobos', message: 'Downloading AI module…', progress: 0 });

  await downloadFile(binaryUrl, cfg.PHOBOS_BINARY + '.tmp', (progress) => {
    send('status', { phase: 'download-phobos', message: 'Downloading AI module…', progress });
  });

  fs.renameSync(cfg.PHOBOS_BINARY + '.tmp', cfg.PHOBOS_BINARY);

  if (process.platform !== 'win32') {
    fs.chmodSync(cfg.PHOBOS_BINARY, 0o755);
  }
}

function getPhobosLiteBinaryUrl() {
  // TODO: replace with Autarch CDN URL when builds are published
  // Returns null → launcher skips AI gracefully
  const base = 'https://releases.autarch.gg/phobos-lite';
  const ver  = '0.1.0';

  const platform = process.platform;
  const arch     = process.arch;  // 'x64' | 'arm64'

  if (platform === 'win32'  && arch === 'x64')   return `${base}/${ver}/phobos-lite-win-x64.exe`;
  if (platform === 'linux'  && arch === 'x64')   return `${base}/${ver}/phobos-lite-linux-x64`;
  if (platform === 'linux'  && arch === 'arm64') return `${base}/${ver}/phobos-lite-linux-arm64`;
  if (platform === 'darwin' && arch === 'x64')   return `${base}/${ver}/phobos-lite-mac-x64`;
  if (platform === 'darwin' && arch === 'arm64') return `${base}/${ver}/phobos-lite-mac-arm64`;
  return null;
}

// ─── PHOBOS-Lite process management ──────────────────────────────────────────
async function startPhobos() {
  if (!fs.existsSync(cfg.PHOBOS_BINARY)) {
    // No binary — write a null provider file so the game knows to skip AI
    writeProviderFile(null);
    return;
  }

  // Kill any leftover instance from a previous launch
  stopPhobos();

  const args = [
    '--port',     String(cfg.PHOBOS_PORT),
    '--mode',     'game',
    // These flags tell phobos-lite which GPU to avoid (the primary display adapter)
    // phobos-lite reads PHOBOS_EXCLUDE_GPU_INDEX from env too, for redundancy
    '--exclude-primary-gpu',
  ];

  const env = {
    ...process.env,
    PHOBOS_PORT:              String(cfg.PHOBOS_PORT),
    PHOBOS_MODE:              'game',
    PHOBOS_EXCLUDE_PRIMARY:   '1',   // phobos-lite skips device index 0 (primary display)
    PHOBOS_MODEL_DIR:         path.join(cfg.ROOT_PATH, 'phobos-lite', 'models'),
  };

  phobosProc = spawn(cfg.PHOBOS_BINARY, args, {
    env,
    cwd:   path.dirname(cfg.PHOBOS_BINARY),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Pipe logs to a file for diagnostics
  const logPath = path.join(cfg.ROOT_PATH, 'phobos-lite', 'phobos.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  phobosProc.stdout.pipe(logStream);
  phobosProc.stderr.pipe(logStream);

  phobosProc.on('exit', (code) => {
    console.log(`[PHOBOS] exited with code ${code}`);
    phobosProc = null;
  });

  // Wait for health check
  const model = await waitForPhobosHealth();

  // Write provider file for the game to read at startup
  writeProviderFile({
    type:        'phobos-lite',
    url:         `http://127.0.0.1:${cfg.PHOBOS_PORT}`,
    chatPath:    '/v1/chat/completions',
    healthPath:  '/health',
    model,
    port:        cfg.PHOBOS_PORT,
  });

  send('ai-ready', { model });
}

function stopPhobos() {
  clearInterval(phobosHealthTimer);
  if (phobosProc) {
    try { phobosProc.kill('SIGTERM'); } catch {}
    phobosProc = null;
  }
}

async function waitForPhobosHealth() {
  const deadline = Date.now() + cfg.PHOBOS_HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const text = await fetchLocalJson(`http://127.0.0.1:${cfg.PHOBOS_PORT}/health`);
      if (text && text.status === 'ok') {
        return text.model || 'unknown';
      }
    } catch {
      // not ready yet
    }
    await sleep(cfg.PHOBOS_HEALTH_POLL_MS);
    send('status', { phase: 'starting-ai', message: 'Waiting for AI engine…' });
  }

  // Timed out — log and continue without AI rather than blocking the game
  console.warn('[PHOBOS] Health check timed out — launching game without AI');
  writeProviderFile(null);
  return null;
}

function writeProviderFile(provider) {
  // provider = null → AI not available
  const content = JSON.stringify({
    available:  provider !== null,
    provider:   provider || null,
    writtenAt:  new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(cfg.PHOBOS_PROVIDER_FILE, content, 'utf8');
}

// ─── IPC: launch game ─────────────────────────────────────────────────────────
ipcMain.handle('game:launch', () => {
  if (!fs.existsSync(cfg.GAME_EXE)) {
    send('status', { phase: 'error', message: 'Game executable not found.' });
    return;
  }

  const child = spawn(cfg.GAME_EXE, [], {
    cwd:      cfg.GAME_DIR,
    detached: true,
    stdio:    'ignore',
  });
  child.unref();

  // Close launcher after a short delay so the game has time to initialise
  setTimeout(() => { app.quit(); }, 1500);
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { resolve(data); });
    }).on('error', reject);
  });
}

function fetchLocalJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('bad json')); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;

    const doDownload = (targetUrl) => {
      mod.get(targetUrl, (res) => {
        // Follow redirects (GitHub releases redirect to S3)
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;

        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) {
            onProgress(Math.round((received / total) * 100));
          }
        });
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      }).on('error', reject);
    };

    doDownload(url);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

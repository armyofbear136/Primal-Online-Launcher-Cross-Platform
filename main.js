// main.js — Electron main process

'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const os     = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const cfg = require('./config');

// ─── Globals ──────────────────────────────────────────────────────────────────
let mainWindow  = null;
let phobosProc  = null;
let activeChannel = null;   // set once user picks stable/experimental

const isDev = process.argv.includes('--dev');

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    resizable: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => { stopPhobos(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { stopPhobos(); });

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('window:close',    () => app.quit());
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('shell:openUrl',   (_, url) => shell.openExternal(url));

// Channel selection → kick off launch sequence
ipcMain.handle('launcher:selectChannel', async (_, channelId) => {
  activeChannel = cfg.getChannelConfig(channelId);
  try {
    await runLaunchSequence();
  } catch (err) {
    send('status', { phase: 'error', message: err.message });
  }
});

// Retry — re-runs the sequence with the same channel
ipcMain.handle("launcher:retry", async () => {
  if (!activeChannel) return;
  try {
    await runLaunchSequence();
  } catch (err) {
    send("status", { phase: "error", message: err.message });
  }
});

// Launch the game — watch the game process so PHOBOS dies when the game does
ipcMain.handle('game:launch', () => {
  const gameExe = activeChannel?.gameExe;
  const gameDir = activeChannel?.gameDir;

  if (!activeChannel || !gameExe) {
    send('status', { phase: 'error', message: 'No channel selected.' });
    return;
  }

  // Log paths for debugging
  console.log(`[Launch] gameExe: ${gameExe}`);
  console.log(`[Launch] gameDir: ${gameDir}`);
  console.log(`[Launch] exists: ${fs.existsSync(gameExe)}`);

  if (!fs.existsSync(gameExe)) {
    send('status', { phase: 'error', message: `Game executable not found at: ${gameExe}` });
    return;
  }

  let child;
  if (process.platform === 'darwin') {
    // macOS: chmod the binary and all executables in the .app bundle
    try { fs.chmodSync(gameExe, 0o755); } catch (e) { console.log('[Launch] chmod failed:', e.message); }

    // Derive the .app path from the exe path (go up from Contents/MacOS/binary)
    const appPath = gameExe.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    console.log(`[Launch] macOS appPath: ${appPath}`);
    console.log(`[Launch] appPath exists: ${fs.existsSync(appPath)}`);

    // Remove quarantine attribute (macOS blocks unsigned apps downloaded from internet)
    try {
      require('child_process').execSync(`xattr -rd com.apple.quarantine "${appPath}"`, { timeout: 5000 });
      console.log('[Launch] Quarantine attribute removed');
    } catch (e) { console.log('[Launch] xattr failed (may not be quarantined):', e.message); }

    child = spawn('open', ['-W', appPath], {
      cwd: gameDir, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Capture open's output for debugging
    let openStdout = '', openStderr = '';
    child.stdout?.on('data', (c) => { openStdout += c; });
    child.stderr?.on('data', (c) => { openStderr += c; });

    child.on('exit', (code) => {
      console.log(`[Launch] open exited with code ${code}`);
      if (openStdout) console.log(`[Launch] stdout: ${openStdout}`);
      if (openStderr) console.log(`[Launch] stderr: ${openStderr}`);

      if (code !== 0) {
        // open failed — show error, don't quit
        mainWindow?.show();
        send('status', { phase: 'error', message: `Game failed to launch (code ${code}). ${openStderr}`.trim() });
        return;
      }
      // Game closed normally
      stopPhobos();
      app.quit();
    });

    child.on('error', (err) => {
      console.log(`[Launch] spawn error: ${err.message}`);
      mainWindow?.show();
      send('status', { phase: 'error', message: `Launch failed: ${err.message}` });
    });
  } else {
    // Windows/Linux: direct spawn
    // Keep the launcher process alive but hidden so we can watch the game
    mainWindow?.hide();

    child = spawn(gameExe, [], {
      cwd: gameDir, detached: false, stdio: 'ignore',
    });

    child.on('exit', () => {
      stopPhobos();
      app.quit();
    });

    child.on('error', (err) => {
      mainWindow?.show();
      send('status', { phase: 'error', message: `Launch failed: ${err.message}` });
    });
  }
});

// ─── Game download (user-initiated) ──────────────────────────────────────────
ipcMain.handle('launcher:downloadGame', async () => {
  try {
    await downloadGame();
    // Game is now installed/updated — run AI auto-launch if configured
    const prefs = readPrefs();
    if (prefs.autoLaunchAI && fs.existsSync(cfg.PHOBOS_BINARY)) {
      setImmediate(async () => {
        try {
          send('ai-status', { phase: 'starting', message: 'Auto-starting AI engine…' });
          await ensurePhobosLite();
          await startPhobos();
        } catch (err) {
          log(`Auto-launch AI failed: ${err.message}`);
          writeProviderFile(null);
          send('ai-status', { phase: 'error', message: err.message });
        }
      });
    }
  } catch (err) {
    send('status', { phase: 'error', message: err.message });
  }
});

// ─── AI platform support query ───────────────────────────────────────────────
ipcMain.handle('launcher:aiSupported', () => cfg.PHOBOS_ZIP_URL !== null);

// ─── AI opt-in handler ───────────────────────────────────────────────────────
// Called after user accepts the model licence and clicks Enable.
// Downloads the binary if needed, downloads the model, starts llama-server.
ipcMain.handle('launcher:enableAI', async () => {
  try {
    send('ai-status', { phase: 'download-binary', message: 'Downloading AI module…', progress: 0 });
    await ensurePhobosLite();

    send('ai-status', { phase: 'starting', message: 'Starting AI engine…' });
    await startPhobos();

    // First successful install — default auto-launch to true
    const prefs = readPrefs();
    if (prefs.autoLaunchAI === undefined) {
      writePrefs({ autoLaunchAI: true, aiInstalled: true });
      send('prefs', readPrefs());
    } else {
      writePrefs({ aiInstalled: true });
    }
    send('ai-status', { phase: 'ready' });
  } catch (err) {
    console.warn('[PHOBOS] Enable AI failed:', err.message);
    writeProviderFile(null);
    send('ai-status', { phase: 'error', message: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Preferences ─────────────────────────────────────────────────────────────
// Flat JSON file: { autoLaunchAI: bool, aiInstalled: bool }
// Defaults: autoLaunchAI=true once AI is first installed, false before.

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(cfg.PREFS_FILE, 'utf8')); }
  catch { return {}; }
}

function writePrefs(patch) {
  const current = readPrefs();
  const next    = { ...current, ...patch };
  fs.writeFileSync(cfg.PREFS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

ipcMain.handle('prefs:get', () => readPrefs());
ipcMain.handle('prefs:set', (_, patch) => writePrefs(patch));

// ─── Launch sequence ──────────────────────────────────────────────────────────
async function runLaunchSequence() {
  // 1. Fetch announcement (non-blocking — fire and forget to renderer)
  fetchAnnouncement(activeChannel.announcementUrl);

  // 2. Check version only — never auto-downloads. User must confirm.
  send('status', { phase: 'check', message: 'Checking for updates…' });
  await checkGame();

  // Auto-launch AI if user previously opted in and the binary is installed.
  // This runs when the game is already up to date (checkGame sent phase:'ready').
  // When checkGame sends 'needs-install' or 'update-available', the renderer shows
  // a prompt; user triggers launcher:downloadGame which has its own auto-launch path.
  const prefs = readPrefs();
  if (prefs.autoLaunchAI && fs.existsSync(cfg.PHOBOS_BINARY)) {
    setImmediate(async () => {
      try {
        send('ai-status', { phase: 'starting', message: 'Auto-starting AI engine…' });
        await ensurePhobosLite();
        await startPhobos();
      } catch (err) {
        log(`Auto-launch AI failed: ${err.message}`);
        writeProviderFile(null);
        send('ai-status', { phase: 'error', message: err.message });
      }
    });
  } else {
    writeProviderFile(null);
  }
}

// ─── Announcement ─────────────────────────────────────────────────────────────
async function fetchAnnouncement(url) {
  try {
    const html = await fetchText(url);
    const text = extractTextFromHtml(html);
    send('announcement', { text });
  } catch {
    send('announcement', { text: null });  // renderer shows fallback
  }
}

function extractTextFromHtml(html) {
  // Strip scripts and styles
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Try to grab the Google Doc content div
  const m = html.match(/<div[^>]*id="contents"[^>]*>([\s\S]*?)<\/div>\s*<\/body>/i);
  if (m) html = m[1];

  // Block-level tags → newlines
  html = html.replace(/<\/p>/gi, '\n\n');
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(/<\/h[1-6]>/gi, '\n\n');
  html = html.replace(/<\/li>/gi, '\n');

  // Strip all remaining tags
  html = html.replace(/<[^>]+>/g, '');

  // Decode entities manually (no DOM available in main process)
  html = html
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ');

  // Normalise whitespace
  html = html.replace(/[ \t]+/g, ' ');
  html = html.replace(/\n[ \t]+/g, '\n');
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

// ─── Game update ──────────────────────────────────────────────────────────────
// checkGame: check version only — never auto-downloads. Tells renderer what's available.
async function checkGame() {
  const { versionFile, gameExe } = activeChannel;

  let localVersion = null;
  try { localVersion = fs.readFileSync(versionFile, 'utf8').trim(); } catch {}

  let onlineVersion = null;
  try {
    onlineVersion = (await fetchText(activeChannel.versionUrl)).trim();
  } catch {
    // Offline
    if (fs.existsSync(gameExe)) {
      send('version', { version: localVersion, channel: activeChannel.label });
      send('status', { phase: 'ready', message: '' });
    } else {
      send('status', { phase: 'needs-install', message: 'No internet connection. Game not installed.' });
    }
    return;
  }

  send('version', { version: localVersion || onlineVersion, channel: activeChannel.label });

  if (localVersion === onlineVersion && fs.existsSync(gameExe)) {
    // Up to date — go straight to ready
    send('status', { phase: 'ready', message: '' });
  } else if (localVersion && fs.existsSync(gameExe)) {
    // Update available — prompt user
    send('status', { phase: 'update-available', onlineVersion, localVersion });
  } else {
    // Not installed — prompt user
    send('status', { phase: 'needs-install', onlineVersion });
  }
}

// downloadGame: called by user action (launcher:downloadGame IPC)
async function downloadGame() {
  const { versionFile, versionUrl, downloadUrl, gameZip, gameExe } = activeChannel;

  let localVersion = null;
  try { localVersion = fs.readFileSync(versionFile, 'utf8').trim(); } catch {}

  let onlineVersion = null;
  try { onlineVersion = (await fetchText(versionUrl)).trim(); } catch (err) {
    send('status', { phase: 'error', message: `Version check failed: ${err.message}` }); return;
  }

  const isUpdate = localVersion !== null && fs.existsSync(gameExe);
  send('status', {
    phase:    isUpdate ? 'download-update' : 'download-game',
    message:  isUpdate ? 'Downloading update…' : 'Downloading game…',
    progress: 0,
  });

  try {
    fs.mkdirSync(path.dirname(gameZip), { recursive: true });
    await downloadFile(downloadUrl, gameZip, (progress, received, total, speed, eta) => {
      send('status', {
        phase:    isUpdate ? 'download-update' : 'download-game',
        message:  isUpdate ? 'Downloading update…' : 'Downloading game…',
        progress,
        received: formatBytes(received), total: formatBytes(total),
        speed:    formatBytes(speed) + '/s', eta: formatEta(eta),
      });
    });

    send('status', { phase: 'extracting', message: 'Extracting…', progress: 100 });
    const zip = new AdmZip(gameZip);
    zip.extractAllTo(cfg.ROOT_PATH, true);
    fs.unlinkSync(gameZip);
    fs.writeFileSync(versionFile, onlineVersion, 'utf8');
    send('version', { version: onlineVersion, channel: activeChannel.label });
    send('status', { phase: 'ready', message: '' });
  } catch (err) {
    send('status', { phase: 'error', message: err.message });
  }
}

// ─── PHOBOS-Lite ──────────────────────────────────────────────────────────────
async function ensurePhobosLite() {
  if (!cfg.PHOBOS_ZIP_URL) return;  // unsupported platform — skip silently

  // Check local version against GitHub release version.txt
  let localVersion  = null;
  let remoteVersion = null;

  try { localVersion = fs.readFileSync(cfg.PHOBOS_VERSION_FILE, 'utf8').trim(); } catch {}
  try { remoteVersion = (await fetchText(cfg.PHOBOS_VERSION_URL)).trim(); } catch {
    // Network unavailable — if binary exists, use it as-is
    if (fs.existsSync(cfg.PHOBOS_BINARY)) return;
    throw new Error('Cannot reach PHOBOS-Lite release server and no local installation found.');
  }

  // Already up to date
  if (localVersion === remoteVersion && fs.existsSync(cfg.PHOBOS_BINARY)) {
    log(`PHOBOS-Lite ${localVersion} already installed`);
    return;
  }

  const action = localVersion ? `Updating AI module to ${remoteVersion}…` : 'Downloading AI module…';
  log(`PHOBOS-Lite: ${action}`);

  fs.mkdirSync(cfg.PHOBOS_DIR, { recursive: true });

  const zipDest = path.join(cfg.PHOBOS_DIR, cfg.PHOBOS_ZIP_NAME);

  send('ai-status', { phase: 'download-binary', message: action, progress: 0 });

  await downloadFile(cfg.PHOBOS_ZIP_URL, zipDest, (progress, received, total, speed, eta) => {
    send('ai-status', {
      phase:    'download-binary',
      message:  action,
      progress,
      received: formatBytes(received),
      total:    formatBytes(total),
      speed:    formatBytes(speed) + '/s',
      eta:      formatEta(eta),
    });
  });

  // Extract zip over existing install (AdmZip overwrites)
  send('ai-status', { phase: 'download-binary', message: 'Extracting AI module…', progress: 100 });
  const zip = new AdmZip(zipDest);
  zip.extractAllTo(cfg.PHOBOS_DIR, true);
  fs.unlinkSync(zipDest);

  // Mark executable on Unix
  if (process.platform !== 'win32' && fs.existsSync(cfg.PHOBOS_BINARY)) {
    fs.chmodSync(cfg.PHOBOS_BINARY, 0o755);
    // Also chmod llama-server if present
    const llamaBin = path.join(cfg.PHOBOS_DIR, 'llama-server');
    if (fs.existsSync(llamaBin)) fs.chmodSync(llamaBin, 0o755);
  }

  // Write version file so next launch skips download
  fs.writeFileSync(cfg.PHOBOS_VERSION_FILE, remoteVersion, 'utf8');
  log(`PHOBOS-Lite installed: ${remoteVersion}`);
}

async function startPhobos() {
  if (!fs.existsSync(cfg.PHOBOS_BINARY)) { writeProviderFile(null); return; }

  stopPhobos();

  const env = {
    ...process.env,
    PHOBOS_PORT:            String(cfg.PHOBOS_PORT),
    PHOBOS_MODE:            'game',
    PHOBOS_EXCLUDE_PRIMARY: '1',
    PHOBOS_MODEL_DIR:       path.join(path.dirname(cfg.PHOBOS_BINARY), 'models'),
  };

  phobosProc = spawn(cfg.PHOBOS_BINARY, ['--port', String(cfg.PHOBOS_PORT), '--mode', 'game', '--exclude-primary-gpu'], {
    env, cwd: path.dirname(cfg.PHOBOS_BINARY), stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });

  const logPath = path.join(path.dirname(cfg.PHOBOS_BINARY), 'phobos.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  phobosProc.stdout.pipe(logStream);
  phobosProc.stderr.pipe(logStream);
  phobosProc.on('exit', () => { phobosProc = null; });

  const model = await waitForPhobosHealth();
  writeProviderFile(model ? {
    type: 'phobos-lite', url: `http://127.0.0.1:${cfg.PHOBOS_PORT}`,
    chatPath: '/v1/chat/completions', healthPath: '/health', model, port: cfg.PHOBOS_PORT,
  } : null);

  if (model) send('ai-ready', { model });
}

function stopPhobos() {
  if (phobosProc) { try { phobosProc.kill('SIGTERM'); } catch {} phobosProc = null; }
}

async function waitForPhobosHealth() {
  // phobos-lite goes through three phases after launch:
  //   1. Hardware detection + model selection  (~2-5s,  health: 'starting')
  //   2. Model download from HuggingFace       (minutes, health: 'downloading', progress 0-100)
  //   3. llama-server startup                  (~5-30s, health: 'starting')
  //   4. Ready                                 health: 'ok'
  //
  // We poll /health and surface whatever phase is reported so the
  // progress bar and label stay meaningful throughout.

  const deadline = Date.now() + cfg.PHOBOS_HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const data = await fetchLocalJson(`http://127.0.0.1:${cfg.PHOBOS_PORT}/health`);

      if (data?.status === 'ok') {
        return data.model || 'unknown';
      }

      // Surface download progress if phobos-lite reports it
      if (data?.status === 'downloading') {
        const pct  = data.progress ?? 0;
        const mb   = data.totalMB   ? `${(data.totalMB * pct / 100).toFixed(0)} MB / ${data.totalMB} MB` : '';
        send('ai-status', {
          phase:   'download-model',
          message: `Downloading AI model… ${data.model || ''}`,
          progress: pct,
          received: mb,
          total:    data.totalMB ? `${data.totalMB} MB` : '',
          speed:    data.speedMBs ? `${data.speedMBs.toFixed(1)} MB/s` : '',
          eta:      data.etaSecs  ? formatEta(data.etaSecs)            : '',
        });
      } else {
        // 'starting' — hardware probe or llama-server warming up
        const msg = data?.phase === 'llama-starting'
          ? 'Starting inference engine…'
          : 'Preparing AI engine…';
        send('ai-status', { phase: 'starting', message: msg });
      }
    } catch {
      // phobos-lite not yet listening — still starting up
      send('ai-status', { phase: 'starting', message: 'Starting AI engine…' });
    }

    await sleep(cfg.PHOBOS_HEALTH_POLL_MS);
  }

  log('PHOBOS-Lite health check timed out');
  writeProviderFile(null);
  return null;
}

function writeProviderFile(provider) {
  fs.writeFileSync(cfg.PHOBOS_PROVIDER_FILE, JSON.stringify({
    available: provider !== null, provider: provider || null, writtenAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchLocalJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json')); } });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let lastReceived = 0;
    let lastTime     = Date.now();
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const fail = (err) => { if (!resolved) { resolved = true; reject(err); } };

    const doGet = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return doGet(res.headers.location);
        if (res.statusCode !== 200) return fail(new Error(`HTTP ${res.statusCode}`));

        const total    = parseInt(res.headers['content-length'] || '0', 10);
        let received   = 0;
        const out      = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          received += chunk.length;
          const now     = Date.now();
          const elapsed = (now - lastTime) / 1000;

          if (elapsed >= 0.5 || received === total) {
            const speed = elapsed > 0 ? (received - lastReceived) / elapsed : 0;
            const eta   = speed > 0 ? (total - received) / speed : 0;
            lastReceived = received;
            lastTime     = now;
            const pct    = total > 0 ? Math.round(received / total * 100) : 0;
            if (onProgress) onProgress(pct, received, total, speed, eta);
          }
        });

        res.pipe(out);
        out.on('finish', done);
        out.on('close', done);   // safety — macOS sometimes fires close but not finish
        out.on('error', fail);
        res.on('error', fail);
      }).on('error', fail);
    };

    doGet(url);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024)          return `${bytes} B`;
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)     return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60)   return `${Math.round(seconds)}s remaining`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s remaining`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m remaining`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

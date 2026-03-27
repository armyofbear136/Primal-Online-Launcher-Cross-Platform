// phobos-lite/server.js
// Standalone Node.js process. No PHOBOS-core dependency.
// Entry point for the phobos-lite binary (pkg'd separately from the launcher).
//
// Responsibilities:
//   1. Parse CLI args / env
//   2. Detect hardware, excluding the primary game GPU
//   3. Select best model from catalogue based on available device
//   4. Download model GGUF if not present
//   5. Spawn llama-server (llama.cpp) with correct backend flags
//   6. Serve GET /health and proxy POST /v1/chat/completions
//   7. Clean shutdown on SIGTERM

'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { spawn, execFile } = require('child_process');

// ─── CLI / env parsing ────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));

const PORT             = parseInt(args['--port'] || process.env.PHOBOS_PORT || '52690', 10);
const MODE             = args['--mode'] || process.env.PHOBOS_MODE || 'game';
const EXCLUDE_PRIMARY  = args['--exclude-primary-gpu'] != null
                      || process.env.PHOBOS_EXCLUDE_PRIMARY === '1';
const MODELS_DIR       = process.env.PHOBOS_MODEL_DIR
                      || path.join(path.dirname(process.execPath), 'models');

// llama-server binary — co-located with phobos-lite binary
const LLAMA_SERVER = resolveLlamaServer();

// ─── Model catalogue (mirrors launcher/src/config.js) ────────────────────────
// Keep in sync. In a future monorepo this would be a shared JSON.
const MODEL_CATALOGUE = [
  {
    id:            'gemma-3-4b-it-q4',
    displayName:   'Gemma 3 4B (Q4_K_M)',
    filename:      'gemma-3-4b-it-q4_k_m.gguf',
    hfRepo:        'google/gemma-3-4b-it-GGUF',
    hfFile:        'gemma-3-4b-it-q4_k_m.gguf',
    minVramMB:     3200,
    vramClass:     'gpu-mid',
    contextLength: 8192,
    ngl:           35,   // number of GPU layers to offload
  },
  {
    id:            'gemma-3-1b-it-q8',
    displayName:   'Gemma 3 1B (Q8)',
    filename:      'gemma-3-1b-it-q8_0.gguf',
    hfRepo:        'google/gemma-3-1b-it-GGUF',
    hfFile:        'gemma-3-1b-it-q8_0.gguf',
    minVramMB:     1400,
    vramClass:     'igpu',
    contextLength: 4096,
    ngl:           28,
  },
  {
    id:            'gemma-3-1b-it-q4',
    displayName:   'Gemma 3 1B (Q4_K_M)',
    filename:      'gemma-3-1b-it-q4_k_m.gguf',
    hfRepo:        'google/gemma-3-1b-it-GGUF',
    hfFile:        'gemma-3-1b-it-q4_k_m.gguf',
    minVramMB:     0,    // CPU fallback — always fits
    vramClass:     'cpu',
    contextLength: 4096,
    ngl:           0,    // CPU only
  },
];

// ─── Hardware detection ───────────────────────────────────────────────────────
// Returns array of DeviceInfo sorted by score (best first), with primary excluded.
//
// DeviceInfo {
//   index:      number          device index
//   name:       string
//   vramMB:     number
//   backend:    'cuda' | 'metal' | 'vulkan' | 'rocm' | 'cpu'
//   score:      number          0–4 (higher = prefer)
//   isPrimary:  boolean
// }

async function detectDevices() {
  const devices = [];

  // CPU always available as fallback
  const cpuRam = Math.floor(os.totalmem() / 1024 / 1024);
  devices.push({
    index:     -1,
    name:      `CPU (${os.cpus()[0]?.model || 'unknown'})`,
    vramMB:    Math.floor(cpuRam * 0.6),  // conservative: 60% RAM usable for CPU inference
    backend:   'cpu',
    score:     0,
    isPrimary: false,
  });

  if (process.platform === 'darwin') {
    // Apple Silicon — unified memory, Metal backend
    const metalVram = estimateAppleSiliconVram();
    devices.push({
      index:     0,
      name:      'Apple Silicon (Metal)',
      vramMB:    metalVram,
      backend:   'metal',
      score:     3,
      isPrimary: true,  // on Mac, the only GPU is always the display adapter
    });
  } else {
    // Windows / Linux: query via llama-server --list-devices if available,
    // fall back to sysfs (Linux) or a heuristic (Windows).
    const probed = await probeDevicesViaLlama();
    devices.push(...probed);
  }

  // Sort best-first
  devices.sort((a, b) => b.score - a.score || b.vramMB - a.vramMB);

  log(`Detected ${devices.length} compute devices:`);
  for (const d of devices) {
    log(`  [${d.index}] ${d.name} — ${d.vramMB} MB — ${d.backend} — score ${d.score}${d.isPrimary ? ' (PRIMARY/GAME GPU — excluded)' : ''}`);
  }

  return devices;
}

async function probeDevicesViaLlama() {
  if (!fs.existsSync(LLAMA_SERVER)) return [];

  return new Promise((resolve) => {
    const devices = [];
    const proc = spawn(LLAMA_SERVER, ['--list-devices'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { out += c; });
    proc.on('close', () => {
      const lines = out.split('\n');
      let deviceIndex = 0;
      for (const line of lines) {
        // llama.cpp format: "  Device N: <name> (CUDA/Vulkan/Metal, <N> MB)"
        const m = line.match(/Device\s+(\d+):\s+(.+?)\s+\((.+?),\s+(\d+)\s+MB\)/i);
        if (m) {
          const idx     = parseInt(m[1], 10);
          const name    = m[2].trim();
          const backendRaw = m[3].toLowerCase();
          const vram    = parseInt(m[4], 10);

          let backend = 'vulkan';
          let score   = 1;
          if (backendRaw.includes('cuda'))   { backend = 'cuda';  score = 4; }
          if (backendRaw.includes('rocm'))   { backend = 'rocm';  score = 3; }
          if (backendRaw.includes('metal'))  { backend = 'metal'; score = 3; }
          if (backendRaw.includes('vulkan')) { backend = 'vulkan'; score = idx === 0 ? 2 : 1; }

          devices.push({
            index:     idx,
            name,
            vramMB:    vram,
            backend,
            score,
            isPrimary: idx === 0,  // device 0 = primary display adapter
          });
          deviceIndex++;
        }
      }

      if (devices.length === 0) {
        // llama --list-devices returned nothing (common on Linux without Vulkan setup)
        // Fall through to sysfs probe
        devices.push(...probeSysfsFallback());
      }

      resolve(devices);
    });

    proc.on('error', () => resolve([]));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(devices); }, 5000);
  });
}

function probeSysfsFallback() {
  // Linux sysfs: /sys/class/drm/card*/device/mem_info_vram_total
  const devices = [];
  try {
    const drmPath = '/sys/class/drm';
    if (!fs.existsSync(drmPath)) return devices;

    const cards = fs.readdirSync(drmPath).filter(n => /^card\d+$/.test(n)).sort();
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const vramFile = path.join(drmPath, card, 'device', 'mem_info_vram_total');
      if (!fs.existsSync(vramFile)) continue;

      const vramBytes = parseInt(fs.readFileSync(vramFile, 'utf8').trim(), 10);
      const vramMB    = Math.floor(vramBytes / 1024 / 1024);
      if (vramMB < 100) continue; // skip tiny entries

      // Detect AMD via vendor file
      const vendorFile = path.join(drmPath, card, 'device', 'vendor');
      let vendor = '';
      try { vendor = fs.readFileSync(vendorFile, 'utf8').trim(); } catch {}

      const backend = vendor === '0x1002' ? 'rocm' : 'vulkan';
      const score   = backend === 'rocm' ? 3 : 1;

      devices.push({
        index:     i,
        name:      `GPU ${i} (${card})`,
        vramMB,
        backend,
        score,
        isPrimary: i === 0,
      });
    }
  } catch (err) {
    log(`sysfs probe failed: ${err.message}`);
  }
  return devices;
}

function estimateAppleSiliconVram() {
  // Heuristic: Apple Silicon shares RAM. Conservative: use 40% of total.
  const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
  return Math.floor(totalMB * 0.4);
}

// ─── Device selection ─────────────────────────────────────────────────────────
// Returns the best non-primary device that can fit a model, with its chosen model.

function selectDeviceAndModel(devices) {
  // Filter: exclude primary GPU (game is using it)
  const candidates = devices.filter(d => !(EXCLUDE_PRIMARY && d.isPrimary));

  if (candidates.length === 0) {
    log('No non-primary devices found — falling back to CPU');
    const cpu = devices.find(d => d.backend === 'cpu');
    return cpu ? pickModel(cpu) : null;
  }

  // Walk candidates best-first, find highest model that fits
  for (const device of candidates) {
    const result = pickModel(device);
    if (result) return result;
  }

  // Last resort: CPU with smallest model
  const cpu = devices.find(d => d.backend === 'cpu');
  return cpu ? pickModel(cpu) : null;
}

function pickModel(device) {
  // Walk catalogue top-to-bottom (best model first), pick first that fits
  for (const model of MODEL_CATALOGUE) {
    if (device.vramMB >= model.minVramMB || device.backend === 'cpu') {
      return { device, model };
    }
  }
  return null;
}

// ─── Model download ───────────────────────────────────────────────────────────
async function ensureModel(model) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, model.filename);

  if (fs.existsSync(dest)) {
    log(`Model already present: ${model.filename}`);
    return dest;
  }

  // Download from Hugging Face
  const url = `https://huggingface.co/${model.hfRepo}/resolve/main/${model.hfFile}`;
  log(`Downloading model: ${model.displayName}`);
  log(`  from: ${url}`);
  log(`  to:   ${dest}`);

  await downloadFile(url, dest + '.tmp', (pct) => {
    process.stdout.write(`\r  Progress: ${pct}%   `);
  });

  fs.renameSync(dest + '.tmp', dest);
  process.stdout.write('\n');
  log(`Model download complete: ${model.filename}`);
  return dest;
}

// ─── llama-server management ──────────────────────────────────────────────────
let llamaProc = null;

async function startLlama(device, model, modelPath) {
  stopLlama();

  const serverPort = PORT + 1;  // llama-server on PORT+1, we proxy from PORT

  const args = buildLlamaArgs(device, model, modelPath, serverPort);
  log(`Starting llama-server: ${LLAMA_SERVER}`);
  log(`  args: ${args.join(' ')}`);

  const env = buildLlamaEnv(device);

  llamaProc = spawn(LLAMA_SERVER, args, {
    env,
    cwd:   path.dirname(LLAMA_SERVER),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  llamaProc.stdout.on('data', (c) => process.stdout.write(c));
  llamaProc.stderr.on('data', (c) => process.stderr.write(c));
  llamaProc.on('exit', (code) => { log(`llama-server exited: ${code}`); llamaProc = null; });
  llamaProc.on('error', (err) => { log(`llama-server error: ${err.message}`); });

  // Wait for llama-server to be ready
  await waitForReady(serverPort);

  return serverPort;
}

function buildLlamaArgs(device, model, modelPath, serverPort) {
  const args = [
    '--model',    modelPath,
    '--port',     String(serverPort),
    '--host',     '127.0.0.1',
    '--ctx-size', String(model.contextLength),
    '--n-gpu-layers', String(device.backend === 'cpu' ? 0 : model.ngl),
    '--threads',  String(Math.min(os.cpus().length, 8)),
    '--log-disable',  // suppress llama.cpp verbose logs to stdout
  ];

  // Backend-specific flags
  if (device.backend === 'cuda') {
    args.push('--device', `cuda${device.index}`);
  } else if (device.backend === 'rocm') {
    args.push('--device', `rocm${device.index}`);
    // Suppress ROCm from using GPU 0 (game GPU) when EXCLUDE_PRIMARY is set
    if (EXCLUDE_PRIMARY) {
      args.push('--main-gpu', String(device.index));
    }
  } else if (device.backend === 'metal') {
    // Metal: no device flag needed, always uses the one GPU
    // Limit layers to leave VRAM for the game renderer
    const safeLayers = Math.min(model.ngl, 20);
    args[args.indexOf(String(model.ngl))] = String(safeLayers);
  } else if (device.backend === 'vulkan') {
    // Positional fallback if --device not supported
    args.push('--device', `vulkan${device.index}`);
  } else {
    // CPU: --device none prevents any GPU initialisation
    args.push('--device', 'none');
  }

  return args;
}

function buildLlamaEnv(device) {
  const env = { ...process.env };

  if (device.backend === 'rocm') {
    // Target specific ROCm device, exclude game GPU (index 0)
    env.ROCR_VISIBLE_DEVICES = String(device.index);
    // Tensile library paths for ROCm 7.x
    if (process.env.ROCM_PATH) {
      env.ROCBLAS_TENSILE_LIBPATH  = path.join(process.env.ROCM_PATH, 'lib', 'rocblas', 'library');
      env.HIPBLASLT_TENSILE_LIBPATH = path.join(process.env.ROCM_PATH, 'lib', 'hipblaslt', 'library');
    }
    if (process.platform === 'linux') {
      const ld = process.env.LD_LIBRARY_PATH || '';
      env.LD_LIBRARY_PATH = [
        path.join(path.dirname(LLAMA_SERVER)),
        ld,
      ].filter(Boolean).join(':');
    }
  }

  if (device.backend === 'cuda') {
    // Exclude primary GPU from CUDA visibility
    if (EXCLUDE_PRIMARY) {
      // Build CUDA_VISIBLE_DEVICES excluding device 0 (primary game GPU)
      // This is conservative — if the secondary GPU is index 1, expose only that
      env.CUDA_VISIBLE_DEVICES = String(device.index);
    }
  }

  if (device.backend === 'vulkan' && EXCLUDE_PRIMARY) {
    env.GGML_VK_VISIBLE_DEVICES = String(device.index);
  }

  return env;
}

async function waitForReady(port) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await httpGet(`http://127.0.0.1:${port}/health`);
      log('llama-server is ready');
      return;
    } catch {
      await sleep(800);
    }
  }
  throw new Error('llama-server failed to start within 60 seconds');
}

function stopLlama() {
  if (llamaProc) {
    try { llamaProc.kill('SIGTERM'); } catch {}
    llamaProc = null;
  }
}

// ─── Proxy server ─────────────────────────────────────────────────────────────
// Sits on PORT. Forwards /v1/chat/completions to llama-server on PORT+1.
// Adds GET /health that reports our own readiness + model info.

let activeModel = null;
let llamaPort   = null;
let isReady     = false;

function startProxyServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: isReady ? 'ok' : 'starting',
        model:  activeModel?.id || null,
        device: activeDevice?.name || null,
      }));
      return;
    }

    if (!isReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AI engine is still starting' }));
      return;
    }

    // Proxy everything else to llama-server
    proxyToLlama(req, res);
  });

  server.listen(PORT, '127.0.0.1', () => {
    log(`PHOBOS-Lite proxy listening on port ${PORT}`);
  });
}

function proxyToLlama(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port:     llamaPort,
    path:     req.url,
    method:   req.method,
    headers:  req.headers,
  };

  const proxy = http.request(options, (llamaRes) => {
    res.writeHead(llamaRes.statusCode, llamaRes.headers);
    llamaRes.pipe(res);
  });

  proxy.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  req.pipe(proxy);
}

// ─── Boot sequence ────────────────────────────────────────────────────────────
let activeDevice = null;

async function boot() {
  log(`PHOBOS-Lite starting — mode=${MODE}, port=${PORT}, excludePrimary=${EXCLUDE_PRIMARY}`);
  log(`Models dir: ${MODELS_DIR}`);
  log(`llama-server: ${LLAMA_SERVER}`);

  // Start proxy server immediately so launcher health check doesn't time out
  startProxyServer();

  // Detect hardware
  const devices    = await detectDevices();
  const selection  = selectDeviceAndModel(devices);

  if (!selection) {
    log('ERROR: No viable device/model combination found. Serving health=starting indefinitely.');
    return;
  }

  const { device, model } = selection;
  activeDevice = device;
  activeModel  = model;

  log(`Selected device: ${device.name} (${device.backend}, ${device.vramMB} MB)`);
  log(`Selected model:  ${model.displayName}`);

  // Ensure model is downloaded
  const modelPath = await ensureModel(model);

  // Start llama-server
  llamaPort = await startLlama(device, model, modelPath);

  isReady = true;
  log(`PHOBOS-Lite ready — model=${model.id}, device=${device.name}`);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => { stopLlama(); process.exit(0); });
process.on('SIGINT',  () => { stopLlama(); process.exit(0); });
process.on('exit',    () => { stopLlama(); });

// ─── Utilities ────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i]] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true;
    }
  }
  return out;
}

function resolveLlamaServer() {
  const dir = path.dirname(process.execPath || __filename);
  const bin = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(dir, bin);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const doGet = (u) => {
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return doGet(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

        const total    = parseInt(res.headers['content-length'] || '0', 10);
        let received   = 0;
        const out      = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress(Math.round(received / total * 100));
        });
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

// ─── Go ───────────────────────────────────────────────────────────────────────
boot().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});

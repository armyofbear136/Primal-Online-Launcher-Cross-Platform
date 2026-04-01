// config.js — single source of truth for all launcher constants
// Nothing else should hardcode URLs, ports, or paths.

'use strict';

const path = require('path');
const os   = require('os');

// ─── Release channels ─────────────────────────────────────────────────────────
// Add new channels here only. Nothing else needs to change.
const CHANNELS = {
  stable: {
    id:              'stable',
    label:           'STABLE',
    releaseTag:      'PO-Alpha-Stable',
    announcementUrl: 'https://docs.google.com/document/d/e/2PACX-1vSWep4BRMEMtogWTqLCFAuWktzJz77e-2T_XYxrnte12a4rHOEtN5S-L4Js78LyiheqMWRyxC1HwKZs/pub',
    exeName: {
      win32:  'PO_Alpha_Stable.exe',
      darwin: 'PO_Alpha_Stable.app/Contents/MacOS/Primal Online',
      linux:  'PO_Alpha_Stable',
    },
    zipName: {
      'win32-x64':   'PO_Alpha_Stable_PC_x64.zip',
      'win32-arm64': 'PO_Alpha_Stable_PC_Arm.zip',
      'linux-x64':   'PO_Alpha_Stable_Linux_x64.zip',
      'linux-arm64': 'PO_Alpha_Stable_Linux_Arm.zip',
      'darwin-x64':  'PO_Alpha_Stable_macOS.zip',
      'darwin-arm64':'PO_Alpha_Stable_macOS.zip',
    },
  },
  experimental: {
    id:              'experimental',
    label:           'EXPERIMENTAL',
    releaseTag:      'PO-Alpha-Experimental',
    announcementUrl: 'https://docs.google.com/document/d/e/2PACX-1vS9UGkDj5mcjoxTwaDZJZipbV_GyDMNxkFqJrgYWJOaE_BkyVIUkFydbfJrqKKtJ_IGcHom03YDKz4z/pub',
    exeName: {
      win32:  'PO_Alpha_Experimental.exe',
      darwin: 'PO_Alpha_Experimental.app/Contents/MacOS/Primal Online',
      linux:  'PO_Alpha_Experimental',
    },
    zipName: {
      'win32-x64':   'PO_Alpha_PC_x64_Experimental.zip',
      'win32-arm64': 'PO_Alpha_PC_Arm_Experimental.zip',
      'linux-x64':   'PO_Alpha_Linux_x64_Experimental.zip',
      'linux-arm64': 'PO_Alpha_Linux_Arm_Experimental.zip',
      'darwin-x64':  'PO_Alpha_macOS_Experimental.zip',
      'darwin-arm64':'PO_Alpha_macOS_Experimental.zip',
    },
  },
};

exports.CHANNELS = CHANNELS;

// ─── Runtime paths (channel-dependent) ───────────────────────────────────────
// On Windows/Linux, process.cwd() or PORTABLE_EXECUTABLE_DIR is the launcher's directory.
// On macOS, process.cwd() returns '/' (read-only root) when launched from Finder/Dock.
// Use the directory containing the .app bundle so game files live next to the launcher.
// If running from a DMG (read-only mount), fall back to ~/Library/Application Support/.
function resolveRootPath() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'PrimalOnlineLauncher');
  }
  return process.cwd();
}
const rootPath   = resolveRootPath();
const platformKey = `${process.platform}-${process.arch}`;

exports.ROOT_PATH = rootPath;

exports.getChannelConfig = (channelId) => {
  const ch = CHANNELS[channelId];
  if (!ch) throw new Error(`Unknown channel: ${channelId}`);

  const GITHUB_BASE = `https://github.com/armyofbear136/Primal-Online-Client-Stable/releases/download/${ch.releaseTag}`;
  const zipName     = ch.zipName[platformKey] || ch.zipName['win32-x64']; // safe fallback
  let exeName       = ch.exeName[process.platform] || ch.exeName['linux'];

  if (process.platform === 'linux') {
    if (process.arch === 'x64') exeName += '.x86_64';
    else if (process.arch === 'arm64') exeName += '.arm64';
  }

  const gameDir = process.platform === 'darwin' ? rootPath : path.join(rootPath, 'Primal Online');

  return {
    ...ch,
    versionUrl:  `${GITHUB_BASE}/version.txt`,
    downloadUrl: `${GITHUB_BASE}/${zipName}`,
    zipName,
    versionFile: path.join(rootPath, `version-${channelId}.txt`),
    gameZip:     path.join(rootPath, zipName),
    gameDir,
    gameExe:     path.join(rootPath, 'Primal Online', exeName),
  };
};

// ─── Static URLs ──────────────────────────────────────────────────────────────
exports.DISCORD_URL  = 'https://discord.gg/mDDB2Kfafa';
exports.WEBSITE_URL  = 'https://www.primalonline.net';
exports.PHOBOS_URL   = 'https://autarch.net/phobos';

// ─── Launcher preferences file ────────────────────────────────────────────────
// Persists user choices across sessions (auto-launch AI, etc.)
exports.PREFS_FILE   = path.join(rootPath, 'launcher-prefs.json');

// ─── PHOBOS-Lite ─────────────────────────────────────────────────────────────
exports.PHOBOS_PORT          = 52690;
exports.PHOBOS_HEALTH_URL    = `http://127.0.0.1:52690/health`;
exports.PHOBOS_PROVIDER_FILE = path.join(rootPath, 'phobos-provider.json');
exports.PHOBOS_DIR           = path.join(rootPath, 'phobos-lite');
exports.PHOBOS_BINARY        = process.platform === 'win32'
  ? path.join(rootPath, 'phobos-lite', 'phobos-lite.exe')
  : path.join(rootPath, 'phobos-lite', 'phobos-lite');
exports.PHOBOS_VERSION_FILE  = path.join(rootPath, 'phobos-lite', 'version.txt');

// GitHub release — generic asset names, version tracked via version.txt sibling
const PHOBOS_RELEASE_BASE    = 'https://github.com/armyofbear136/PHOBOS-BUILDS/releases/download/PHOBOS-LITE-LATEST';
exports.PHOBOS_VERSION_URL   = `${PHOBOS_RELEASE_BASE}/version.txt`;
exports.PHOBOS_ZIP_URL       = (() => {
  const { platform, arch } = process;
  // Asset names match the phobos-core build output exactly
  if (platform === 'win32'  && arch === 'x64')   return `${PHOBOS_RELEASE_BASE}/phobos-lite-win32-x64.zip`;
  if (platform === 'win32'  && arch === 'arm64') return `${PHOBOS_RELEASE_BASE}/phobos-lite-win32-arm64.zip`;
  if (platform === 'linux'  && arch === 'x64')   return `${PHOBOS_RELEASE_BASE}/phobos-lite-linux-x64.zip`;
  if (platform === 'linux'  && arch === 'arm64') return `${PHOBOS_RELEASE_BASE}/phobos-lite-linux-arm64.zip`;
  if (platform === 'darwin' && arch === 'arm64') return `${PHOBOS_RELEASE_BASE}/phobos-lite-darwin-arm64.zip`;
  if (platform === 'darwin' && arch === 'x64')   return `${PHOBOS_RELEASE_BASE}/phobos-lite-darwin-x64.zip`;
  return null;  // unsupported platform — AI opt-in will be hidden
})();
exports.PHOBOS_ZIP_NAME      = `phobos-lite-${process.platform}-${process.arch}.zip`;

exports.PHOBOS_MODEL_CATALOGUE = [
  {
    id:            'gemma-3-4b-it-q4',
    displayName:   'Gemma 3 4B (Q4_K_M)',
    filename:      'gemma-3-4b-it-q4_k_m.gguf',
    hfRepo:        'google/gemma-3-4b-it-GGUF',
    hfFile:        'gemma-3-4b-it-q4_k_m.gguf',
    minVramMB:     3200,
    contextLength: 8192,
    ngl:           35,
  },
  {
    id:            'gemma-3-1b-it-q8',
    displayName:   'Gemma 3 1B (Q8)',
    filename:      'gemma-3-1b-it-q8_0.gguf',
    hfRepo:        'google/gemma-3-1b-it-GGUF',
    hfFile:        'gemma-3-1b-it-q8_0.gguf',
    minVramMB:     1400,
    contextLength: 4096,
    ngl:           28,
  },
  {
    id:            'gemma-3-1b-it-q4',
    displayName:   'Gemma 3 1B (Q4_K_M)',
    filename:      'gemma-3-1b-it-q4_k_m.gguf',
    hfRepo:        'google/gemma-3-1b-it-GGUF',
    hfFile:        'gemma-3-1b-it-q4_k_m.gguf',
    minVramMB:     0,
    contextLength: 4096,
    ngl:           0,
  },
];

// Model download can take several minutes on slow connections.
// 30 minutes is generous but safe — user can always close the launcher.
exports.PHOBOS_HEALTH_TIMEOUT_MS = 30 * 60 * 1_000;
exports.PHOBOS_HEALTH_POLL_MS    = 1_500;

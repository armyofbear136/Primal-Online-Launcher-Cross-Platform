// build.all.mjs — trigger a multi-platform build via GitHub Actions
//
// Usage:
//   npm run build:all                     <- trigger and stream live logs
//   npm run build:all -- --no-wait        <- trigger and exit immediately
//   npm run build:all -- --tag v1.2.3     <- trigger + create a GitHub Release
//
// Requires: gh CLI (https://cli.github.com) to be installed and authenticated.
//   brew install gh   /   winget install GitHub.cli   /   apt install gh
//   gh auth login

import { execSync } from 'node:child_process';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const noWait  = args.includes('--no-wait');
const tagArg  = args.find(a => a.startsWith('--tag='))?.split('=')[1]
             ?? (args[args.indexOf('--tag') + 1]);

const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: 'inherit', ...opts });

const runCapture = (cmd) =>
  execSync(cmd, { encoding: 'utf8' }).trim();

const ghAvailable = () => {
  try { runCapture('gh --version'); return true; } catch { return false; }
};

if (!ghAvailable()) {
  console.error('❌ gh CLI not found.');
  console.error('   Install it from https://cli.github.com, then run: gh auth login');
  process.exit(1);
}

if (tagArg) {
  console.log(`🏷️  Creating and pushing tag ${tagArg}...`);
  run(`git tag ${tagArg}`);
  run(`git push origin ${tagArg}`);
  console.log('✅ Tag pushed — workflow will start automatically.');
  if (!noWait) {
    console.log('⏳ Waiting for workflow to complete...');
    run('gh run watch');
  }
  process.exit(0);
}

const branch = runCapture('git rev-parse --abbrev-ref HEAD');
console.log(`🚀 Triggering multi-platform build on branch: ${branch}`);
run(`gh workflow run build.yml --ref ${branch}`);

if (noWait) {
  console.log('✅ Workflow triggered. Monitor at:');
  console.log('   gh run list --workflow=build.yml');
  process.exit(0);
}

console.log('⏳ Waiting for run to start...');
await new Promise(r => setTimeout(r, 4000));

const runId = runCapture('gh run list --workflow=build.yml --limit=1 --json databaseId --jq ".[0].databaseId"');
console.log(`📋 Run ID: ${runId}`);
console.log('   Streaming logs (Ctrl+C to detach, build continues on GitHub)...\n');

run(`gh run watch ${runId}`);

const status = runCapture(`gh run view ${runId} --json conclusion --jq ".conclusion"`);
if (status !== 'success') {
  console.error(`❌ Build failed (conclusion: ${status})`);
  console.error(`   View details: gh run view ${runId} --log-failed`);
  process.exit(1);
}

console.log('\n📥 Downloading artifacts...');
const outDir = path.join(__dirname, 'dist-all');
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir);

run(`gh run download ${runId} --dir ${outDir}`);

console.log('\n✅ All platforms built successfully!');
console.log(`   Artifacts in: dist-all/`);
for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
  if (entry.isDirectory()) console.log(`     ${entry.name}/`);
}
console.log('\nTo release, run:');
console.log('  npm run build:all -- --tag v1.0.0');

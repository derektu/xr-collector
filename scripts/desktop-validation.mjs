import { snapshot as sourceSnapshot } from './validation/core.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  run: { type: 'string' }, commit: { type: 'string' },
  checkout: { type: 'string' }, directory: { type: 'string' }, 'evidence-root': { type: 'string' },
  'allow-dirty': { type: 'boolean' }, status: { type: 'boolean' }, help: { type: 'boolean' },
} });
const root = path.resolve(values.checkout ?? scriptRoot);
if (values.help) {
  console.log('Internal launcher for npm run validation -- start|status --workspace <path>; see docs/development-validation.md.');
  process.exit(0);
}
function json(file) { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function save(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function snapshot() { return sourceSnapshot(root); }
async function readiness(profile) {
  const connection = json(path.join(profile, 'agent-connection.json'));
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash || !connection.token) throw new Error('Invalid local Agent connection');
  async function get(route) {
    const response = await fetch(new URL(route, url), { redirect: 'error', signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${connection.token}` } });
    if (!response.ok) throw new Error(`Agent readiness HTTP ${response.status}`);
    return response.json();
  }
  const health = await get('/api/health');
  const search = await get('/api/search/status');
  if (health.status !== 'ok' || search.status?.state !== 'ready') throw new Error('Application/search not ready');
  return { health, search };
}
function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Preparation failed (${code})`)));
  });
}
try {
  if (!values.run || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(values.run)) throw new Error('Supply --run with a safe scenario ID (letters, digits, dash, underscore)');
  const directory = values.directory ? path.resolve(values.directory) : path.join(root, '.data', 'desktop-validation', values.run);
  const profile = path.join(directory, 'profile');
  const vault = path.join(directory, 'vault');
  const currentFile = path.join(directory, 'current.json');
  if (values.status) {
    const current = json(currentFile);
    if (!alive(current.pid)) throw new Error('Recorded application is not running');
    const result = { checkedAt: new Date().toISOString(), pid: current.pid, ...await readiness(profile) };
    save(path.join(current.evidence, 'readiness.json'), result);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Desktop validation requires macOS or Windows');
  if ((process.platform === 'darwin' && process.arch !== 'arm64') || (process.platform === 'win32' && process.arch !== 'x64')) throw new Error('Current bundled runtimes require Mac arm64 or Windows x64 Node (ARM Windows can emulate x64)');
  const source = snapshot();
  if (!values.commit || values.commit !== source.commit) throw new Error(`Expected --commit ${source.commit}; no launch performed`);
  if (source.status && !values['allow-dirty']) throw new Error('Dirty checkout; commit PR changes or explicitly use --allow-dirty for provisional evidence');
  if (existsSync(currentFile)) {
    const previous = json(currentFile);
    if (previous.pid && alive(previous.pid)) throw new Error('This run is already running; close its application first');
    if (previous.sourceHash !== source.sourceHash || previous.commit !== source.commit) throw new Error('Run belongs to another source revision; choose a new --run ID');
  }
  if (!process.env.npm_execpath) throw new Error('Invoke via npm run validation');
  const target = process.platform === 'win32' ? 'win' : 'mac';
  await runNode([path.join(root, 'scripts/download-runtime.mjs'), target]);
  await runNode([process.env.npm_execpath, 'run', 'build']);
  if (snapshot().sourceHash !== source.sourceHash) throw new Error('Source changed during build; retry after edits stop');
  mkdirSync(profile, { recursive: true }); mkdirSync(vault, { recursive: true });
  const evidence = path.join(values['evidence-root'] ? path.resolve(values['evidence-root']) : path.join(directory, 'evidence'), new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(evidence, { recursive: true });
  const hostArchitecture = process.platform === 'win32'
    ? ({ '0': 'x86', '9': 'x64', '12': 'arm64' }[execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture'], { encoding: 'utf8' }).trim()] ?? 'unknown')
    : os.machine();
  const manifest = { ...source, provisional: Boolean(source.status), createdAt: new Date().toISOString(), checkout: root,
    platform: process.platform, osRelease: os.release(), hostArchitecture, nodeArchitecture: process.arch, nodeVersion: process.version,
    profile, vault, evidence };
  save(path.join(evidence, 'manifest.json'), manifest);
  const env = { ...process.env, XR_COLLECTOR_PROFILE: profile, XR_COLLECTOR_VAULT: vault, XR_COLLECTOR_VALIDATION_WINDOW_SIZE: '880x620' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [key, name] of [['YTDLP', 'yt-dlp'], ['DENO', 'deno'], ['MEILISEARCH', 'meilisearch']]) {
    env[`XR_COLLECTOR_${key}`] = path.join(root, 'resources', 'bin', target, name + (target === 'win' ? '.exe' : ''));
  }
  const executable = path.join(root, 'node_modules', 'electron', 'dist', target === 'win' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron');
  const log = openSync(path.join(evidence, 'application.log'), 'a');
  const child = spawn(executable, ['.'], { cwd: root, env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  let launchError;
  child.once('error', error => { launchError = error; });
  const current = { ...manifest, pid: child.pid };
  save(currentFile, current);
  child.unref();
  for (let attempt = 0; attempt < 45; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null || !alive(child.pid)) throw new Error('Electron exited before readiness; inspect application.log');
    try {
      const connectionFile = path.join(profile, 'agent-connection.json');
      // A previous session's connection file is not evidence for this launch.
      if (statSync(connectionFile).mtimeMs < Date.parse(manifest.createdAt)) continue;
      const result = await readiness(profile);
      save(path.join(evidence, 'readiness.json'), { checkedAt: new Date().toISOString(), pid: child.pid, ...result });
      console.log(JSON.stringify({ ...current, ...result }, null, 2));
      process.exit(0);
    } catch { /* wait for this session's API and search */ }
  }
  throw new Error(`Readiness timeout; inspect ${evidence}. Application may remain open; close only this run before retrying.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

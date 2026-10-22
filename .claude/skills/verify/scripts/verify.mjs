#!/usr/bin/env node
// Command line around the verify library: start, check, seed, capture and stop one Web-mode instance.
// Ticket flows import lib/index.mjs for everything else. Run from the checkout under test:
//   node .claude/skills/verify/scripts/verify.mjs <command> [options]
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { apiState, openPage } from './lib/drive.mjs';
import { attach, launchWeb, portFree, runProcesses, slotHolders, stopRun, sweepStale } from './lib/instance.mjs';
import { checkoutRoot, commitOf, evidenceDir, mainCheckout, SLOTS } from './lib/paths.mjs';
import { collect, idle, subscribe } from './lib/seed.mjs';
import { REAL } from './lib/synthetic.mjs';

const USAGE = `verify.mjs <command>
  doctor   [--run <dir>]                     environment, slots and (with --run) one instance; read-only
  launch   --issue <N> [--data synthetic|real] [--vault selected|fixed|none] [--checkout <dir>] [--no-build]
           --no-build serves the checkout's existing dist/web (npm run build:web) instead of building one
  seed     --run <dir> [--collect <url>]... [--subscribe <url>]... [--wait]
  snapshot --run <dir> --name <name> [--route /documents] [--theme dark|light]
  stop     --run <dir> [--keep]                stop one instance; --keep leaves profile and Vault for inspection
  sweep                                        remove stale slot locks and scratch folders of runs with no live process`;

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  issue: { type: 'string' }, data: { type: 'string', default: 'synthetic' }, vault: { type: 'string', default: 'selected' },
  checkout: { type: 'string' }, 'no-build': { type: 'boolean' }, run: { type: 'string' }, keep: { type: 'boolean' },
  collect: { type: 'string', multiple: true }, subscribe: { type: 'string', multiple: true }, wait: { type: 'boolean' },
  name: { type: 'string' }, route: { type: 'string', default: '/' }, theme: { type: 'string', default: 'dark' }, help: { type: 'boolean' },
} });
const print = (value) => console.log(JSON.stringify(value, null, 2));
const need = (name) => { if (!o[name]) throw new Error(`Missing --${name}\n${USAGE}`); return o[name]; };

/** Whether dist/web/index.html is newer than every file under src/web. */
function builtAfterSources(checkout) {
  const built = path.join(checkout, 'dist', 'web', 'index.html');
  if (!existsSync(built)) return false;
  const newest = readdirSync(path.join(checkout, 'src', 'web'), { recursive: true })
    .map((file) => statSync(path.join(checkout, 'src', 'web', file)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  return statSync(built).mtimeMs >= newest;
}

async function doctor() {
  const checkout = path.resolve(o.checkout ?? checkoutRoot());
  const bin = (name) => path.join(checkout, 'resources', 'bin', 'mac', name);
  const [major, minor] = process.versions.node.split('.').map(Number);
  const checks = {
    platform: { ok: process.platform === 'darwin' && process.arch === 'arm64', value: `${process.platform} ${process.arch}`, fix: 'Mac arm64 only; Windows is pending in SKILL.md' },
    node: { ok: major > 22 || (major === 22 && minor >= 12), value: process.version, fix: 'Node >= 22.12 (.nvmrc)' },
    dependencies: { ok: existsSync(path.join(checkout, 'node_modules', '.bin', 'tsx')) && existsSync(path.join(checkout, 'node_modules', 'playwright')), fix: 'npm ci in the checkout' },
    chromium: { ok: existsSync(chromium.executablePath()), value: chromium.executablePath(), fix: 'npx playwright install chromium' },
    meilisearch: { ok: existsSync(bin('meilisearch')), fix: 'npm run download:runtime' },
    ytdlp: { ok: existsSync(bin(path.join('yt-dlp', 'yt-dlp'))), fix: 'npm run download:runtime (needed by --data real and Electron)' },
    // npm may skip Electron's install script, which downloads the executable.
    electron: { ok: existsSync(path.join(checkout, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')), fix: 'node node_modules/electron/install.js (needed by Electron flows only)' },
    electronBuild: { ok: existsSync(path.join(checkout, 'dist', 'node', 'electron', 'main.js')), fix: 'npm run build (needed by Electron flows only)' },
    // Electron serves the checkout's dist/web; Web mode builds its own copy into the run.
    electronWebCurrent: { ok: builtAfterSources(checkout), fix: 'npm run build; Electron would show an older UI (Electron flows only)' },
  };
  // A slot is usable only with no live lock and all four ports free, the same test launch applies.
  const holders = slotHolders();
  const slots = await Promise.all(SLOTS.map(async (ports) => {
    const holder = holders.find((lock) => lock.slot === ports.slot);
    const busyPorts = [];
    for (const port of [ports.ui, ports.search, ports.agent, ports.feeds]) if (!(await portFree(port))) busyPorts.push(port);
    const state = holder?.live ? 'in use' : busyPorts.length ? 'ports busy' : holder ? 'stale lock' : 'free';
    return { ...ports, state, busyPorts, runDir: holder?.runDir ?? null };
  }));
  const report = { checkout, ...commitOf(checkout), checks, slots, evidenceRoot: path.dirname(evidenceDir('x', checkout)) };
  let healthy = ['platform', 'node', 'dependencies', 'chromium', 'meilisearch'].every((key) => checks[key].ok);
  if (o.run) {
    const instance = attach(o.run);
    const get = (route) => fetch(`${instance.url}${route}`).then((response) => response.json(), () => null);
    const vault = await get('/api/vault/status');
    const search = await get('/api/search/status');
    const now = commitOf(instance.checkout);
    report.instance = {
      runDir: instance.runDir, url: instance.url, data: instance.data, vault: instance.vault, pid: instance.pid,
      processes: runProcesses(instance).map((member) => member.pid),
      health: await fetch(`${instance.url}/api/health`).then((response) => response.ok, () => false),
      search: search?.status?.state ?? null,
      vaultPath: vault?.vaultPath ?? null,
      vaultInsideRun: Boolean(vault?.vaultPath?.startsWith(instance.runDir)),
      launchedCommit: instance.commit, checkoutCommit: now.commit,
      stale: now.commit !== instance.commit ? 'checkout moved to another commit since launch; relaunch to test the current code'
        : now.sourceHash !== instance.sourceHash ? 'checkout has uncommitted changes made after launch; relaunch to test them' : null,
    };
    const i = report.instance;
    healthy &&= i.processes.length > 0 && i.health && (instance.vault === 'none' || (i.search === 'ready' && i.vaultInsideRun));
  }
  report.healthy = healthy;
  print(report);
  if (!healthy) process.exitCode = 2;
}

async function snapshot() {
  const instance = attach(need('run'));
  const name = need('name');
  const { page, close } = await openPage(instance, { route: o.route, colorScheme: o.theme });
  await page.waitForTimeout(600);
  await mkdir(instance.evidence, { recursive: true });
  const png = path.join(instance.evidence, `${name}.png`);
  await page.screenshot({ path: png });
  await close();
  const state = path.join(instance.evidence, `${name}.state.json`);
  await writeFile(state, JSON.stringify({ commit: instance.commit, dirty: instance.dirty, route: o.route, takenAt: new Date().toISOString(), ...(await apiState(instance)) }, null, 2));
  print({ screenshot: png, state });
}

async function main() {
  const command = positionals[0];
  if (o.help || !command) { console.log(USAGE); return; }
  if (command === 'doctor') return doctor();
  if (command === 'launch') {
    if (!['synthetic', 'real'].includes(o.data) || !['selected', 'fixed', 'none'].includes(o.vault)) throw new Error(USAGE);
    const instance = await launchWeb({ issue: need('issue'), checkout: o.checkout, data: o.data, vault: o.vault, build: !o['no-build'] });
    const { api, catalog, updateCatalog, stop, ...record } = instance;
    if (o.data === 'real') record.real = REAL;
    return print(record);
  }
  if (command === 'seed') {
    const instance = attach(need('run'));
    const submitted = [];
    for (const url of o.subscribe ?? []) submitted.push({ subscribe: url, result: await subscribe(instance, url) });
    for (const url of o.collect ?? []) submitted.push({ collect: url, result: await collect(instance, url) });
    const overview = o.wait ? await idle(instance) : undefined;
    return print({ submitted, ...(overview ? { failed: overview.failed } : {}) });
  }
  if (command === 'snapshot') return snapshot();
  if (command === 'stop') return print(await stopRun(need('run'), { keep: o.keep }));
  if (command === 'sweep') return print(sweepStale(mainCheckout()));
  throw new Error(`Unknown command ${command}\n${USAGE}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

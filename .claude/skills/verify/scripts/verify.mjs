#!/usr/bin/env node
// Command line around the verify library: start, check, seed, capture and stop one Web-mode instance.
// Ticket flows import lib/index.mjs for everything else. Run from the checkout under test:
//   node .claude/skills/verify/scripts/verify.mjs <command> [options]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { openPage } from './lib/drive.mjs';
import { attach, launchWeb, portFree, runProcesses, slotHolders, stopRun, sweepStale } from './lib/instance.mjs';
import { checkoutRoot, commitOf, evidenceDir, mainCheckout, SLOTS } from './lib/paths.mjs';
import { environment, exe, WINDOWS } from './lib/platform.mjs';
import { BIN_PLATFORM, desktopTarget, runtimeBin } from './lib/target.mjs';
import { collect, idle, subscribe } from './lib/seed.mjs';
import { evidenceFreshness } from './lib/freshness.mjs';
import { findFeature, readFeatures } from './lib/features.mjs';
import { listFlows, runFlows, selectFlows } from './lib/flows.mjs';
import { flowHistory, historyTable, readFlowResults } from './lib/history.mjs';
import { apiState, readState } from './lib/state.mjs';
import { readResults, summarize } from './lib/summary.mjs';
import { REAL } from './lib/synthetic.mjs';

const USAGE = `verify.mjs <command>
  doctor   [--run <dir>] [--app <path>] [--electron] [--issue <N>]
           environment, slots, (with --run) one instance and (with --app) a packaged app (a .app on macOS, the .exe
           on Windows); --electron requires the development Electron; with --app or --electron the run is a Desktop
           one and Chromium (Web mode) is not required; read-only; "missing" lists what is not ready, each with its
           fix; exit code 2 when not healthy; --issue lists each results.json of that issue's evidence as current
           or STALE against its checkout, which leaves the exit code alone
  launch   --issue <N> [--label <name>] [--evidence <dir>] [--data synthetic|real] [--vault selected|fixed|none] [--checkout <dir>] [--no-build]
           evidence goes to .local/ticket-artifacts/<N>[/<label>]/ of the worktree the command runs in;
           a label already used gets the next free <label>-2, <label>-3…; the output's evidence and label name it;
           --evidence <dir> writes it there instead (a missing or empty folder);
           --checkout picks the version under test; --no-build serves the checkout's existing dist/web
  state    --run <dir>                         the run's data: api, vault, profile and index side by side; read-only
  seed     --run <dir> [--collect <url>]... [--subscribe <url>]... [--wait]
  snapshot --run <dir> --name <name> [--route /documents] [--theme dark|light]
  stop     --run <dir> [--keep]                stop one instance; --keep leaves profile and Vault for inspection
  sweep                                        remove stale slot locks and scratch folders of runs with no live process
  flows list [--tier <tier>] [--feature <file>]
           the recorded regression flows: tier, the feature-map sub-features each covers, overBudget
  flows run [<flow>...] --issue <N> [--label <name>] [--checkout <dir>] [--web|--desktop] [--tier <tier>] [--feature <file>] [--jobs <N>]
           runs the named recorded flows (all without names), each on its own instance; --web is every flow
           neither Desktop nor real-source (what CI runs); --tier keeps core, feature, platform or real;
           --feature keeps the flows covering a sub-feature of that feature file (subscriptions or
           subscriptions.md); --jobs runs up to N at once (default 1, at most one per verify slot; a Desktop
           flow always runs alone); the flows and this library come from the checkout the command runs in,
           --checkout picks only the src/ under test; evidence goes to
           .local/ticket-artifacts/<N>/<label>[-N]/<flow>/ (label defaults to flows); each results.json records
           timings (prepareMs, runMs, cleanupMs) and the run ends with a table of them, marking flows over the
           one-flow budget; exit code 1 when any flow fails
  flows history [--from <dir>] [--runs <N>]
           each flow's runs, failures with their causes, median and longest total, and runs over the one-flow
           budget, from every results.json under --from, or else from the Web regression results of the last
           N (default 30) CI runs, downloaded with gh
  summary  --commit <SHA> [--platform darwin|win32]... [--scenario <ID>]... <results.json>...
           whether every scenario passed on every given platform (any one platform without --platform), counting
           only results of that commit from a clean checkout; --scenario names a scenario the flow must record;
           exit code 2 when not complete`;

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  issue: { type: 'string' }, label: { type: 'string' }, evidence: { type: 'string' }, app: { type: 'string' }, electron: { type: 'boolean' }, data: { type: 'string', default: 'synthetic' }, vault: { type: 'string', default: 'selected' },
  checkout: { type: 'string' }, 'no-build': { type: 'boolean' }, run: { type: 'string' }, keep: { type: 'boolean' },
  collect: { type: 'string', multiple: true }, subscribe: { type: 'string', multiple: true }, wait: { type: 'boolean' },
  name: { type: 'string' }, route: { type: 'string', default: '/' }, theme: { type: 'string', default: 'dark' }, help: { type: 'boolean' },
  commit: { type: 'string' }, platform: { type: 'string', multiple: true }, scenario: { type: 'string', multiple: true },
  web: { type: 'boolean' }, desktop: { type: 'boolean' }, jobs: { type: 'string', default: '1' },
  tier: { type: 'string' }, feature: { type: 'string' }, from: { type: 'string' }, runs: { type: 'string', default: '30' },
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

/**
 * `flows history`: reads every results.json under --from, or downloads the `web-regression-results-*`
 * artifacts of the last --runs CI runs with gh (runs without one, such as Markdown-only changes or
 * reused main pushes, are skipped), and prints each flow's record as JSON and as a table.
 */
async function history() {
  if (!/^\d+$/u.test(o.runs) || Number(o.runs) < 1) throw new Error(`--runs is a whole number of CI runs\n${USAGE}`);
  let from = o.from && path.resolve(o.from);
  let scratch;
  try {
    if (!from) {
      scratch = await mkdtemp(path.join(os.tmpdir(), 'xr-flow-history-'));
      from = scratch;
      const runs = JSON.parse(execFileSync('gh', ['run', 'list', '--workflow', 'ci.yml', '--limit', o.runs, '--json', 'databaseId'], { encoding: 'utf8' }));
      for (const { databaseId } of runs) {
        try {
          execFileSync('gh', ['run', 'download', String(databaseId), '--pattern', 'web-regression-results-*', '--dir', path.join(scratch, String(databaseId))], { stdio: 'ignore' });
        } catch {
          // The run kept no Web regression results.
        }
      }
    }
    const records = flowHistory(readFlowResults(from));
    print(records);
    console.log(historyTable(records));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

async function doctor() {
  const checkout = path.resolve(o.checkout ?? checkoutRoot());
  const bin = runtimeBin(checkout);
  const download = WINDOWS ? 'npm run download:runtime:win' : 'npm run download:runtime';
  const [major, minor] = process.versions.node.split('.').map(Number);
  const item = (ok, fields) => ({ ok, ...fields });
  const machine = environment();
  // The runtime programs and packages are Mac arm64 and Windows x64. On Windows ARM64 the x64 Node
  // runs under emulation, which the value says, so results are never taken for native x64 ones.
  const supported = (process.platform === 'darwin' && process.arch === 'arm64') || (WINDOWS && process.arch === 'x64');
  const checks = {
    platform: item(supported, {
      value: `${process.platform} ${process.arch}${machine.emulated ? ` (emulated on ${machine.hostArch})` : ''}`,
      fix: WINDOWS ? 'Windows x64 Node (the runtime programs and npm run package:win are x64; on Windows ARM64 use x64 Node under emulation)'
        : 'Mac arm64 Node (an x64 Node runs under Rosetta and tests another architecture)',
    }),
    node: item(major > 22 || (major === 22 && minor >= 12), { value: process.version, fix: 'Node >= 22.12 (.nvmrc)' }),
    dependencies: item(existsSync(path.join(checkout, 'node_modules', '.bin', 'tsx')) && existsSync(path.join(checkout, 'node_modules', 'playwright')), { fix: 'npm ci in the checkout' }),
    chromium: item(existsSync(chromium.executablePath()), { path: chromium.executablePath(), fix: `npx playwright install chromium${WINDOWS ? ' (Web mode, which runs on macOS only)' : ''}` }),
    runtimeBin: item(existsSync(bin), { path: bin, fix: `${download} (resources/bin/${BIN_PLATFORM})` }),
    meilisearch: item(existsSync(path.join(bin, exe('meilisearch'))), { path: path.join(bin, exe('meilisearch')), fix: download }),
    ytdlp: item(existsSync(path.join(bin, 'yt-dlp', exe('yt-dlp'))), { path: path.join(bin, 'yt-dlp', exe('yt-dlp')), fix: `${download} (needed by --data real and Electron)` }),
  };
  // Chromium serves Web mode only, which Windows does not run and a Desktop run (--app, --electron) does not use.
  const desktop = Boolean(o.app || o.electron);
  const required = ['platform', 'node', 'dependencies', ...(WINDOWS || desktop ? [] : ['chromium']), 'runtimeBin', 'meilisearch'];
  /** The prerequisites of a Desktop target, or one failed check on a platform Desktop runs do not support. */
  const desktopNeeds = (app) => {
    try {
      return desktopTarget({ checkout, app }).requires;
    } catch (error) {
      return [{ check: 'desktop', ok: false, fix: error.message }];
    }
  };
  // Prerequisites of the development Electron: required with --electron, listed for reference otherwise.
  for (const need of desktopNeeds()) {
    if (need.check in checks) continue;
    checks[need.check] = item(need.ok, { path: need.path, fix: `${need.fix} (Electron flows only)` });
    if (o.electron) required.push(need.check);
  }
  // Electron serves the checkout's dist/web; Web mode builds its own copy into the run.
  checks.electronWebCurrent = item(builtAfterSources(checkout), { fix: 'npm run build; Electron would show an older UI (Electron flows only)' });
  if (o.electron) required.push('electronWebCurrent');
  if (o.app) {
    for (const need of desktopNeeds(o.app)) {
      checks[need.check] = item(need.ok, { path: need.path, ...(need.value !== undefined ? { value: need.value } : {}), fix: need.fix });
      required.push(need.check);
    }
  }
  // A slot is usable only with no live lock and all four ports free, the same test launch applies.
  const holders = slotHolders();
  const slots = await Promise.all(SLOTS.map(async (ports) => {
    const holder = holders.find((lock) => lock.slot === ports.slot);
    const busyPorts = [];
    for (const port of [ports.ui, ports.search, ports.agent, ports.feeds]) if (!(await portFree(port))) busyPorts.push(port);
    const state = holder?.live ? 'in use' : busyPorts.length ? 'ports busy' : holder ? 'stale lock' : 'free';
    return { ...ports, state, busyPorts, runDir: holder?.runDir ?? null };
  }));
  const missing = Object.entries(checks).filter(([, check]) => !check.ok)
    .map(([check, { path: file, fix }]) => ({ check, required: required.includes(check), ...(file ? { path: file } : {}), fix }));
  const report = { checkout, ...commitOf(checkout), environment: machine, ...(o.app ? { app: path.resolve(o.app) } : {}), missing, checks, slots, evidenceRoot: path.dirname(evidenceDir('x')) };
  let healthy = required.every((key) => checks[key].ok);
  if (o.run) {
    const stored = JSON.parse(await readFile(path.join(o.run, 'run.json'), 'utf8'));
    const native = stored.kind === 'electron';
    // Native UI driving stays with its owner. Its known UI origin exports the current Agent
    // connection on demand; run.json never acts as a credential snapshot or product discovery file.
    const instance = native ? stored : attach(o.run);
    const uiUrl = native ? instance.uiUrl : instance.url;
    const processes = runProcesses(instance);
    const appRunning = !native || processes.some((member) => !member.holder);
    const uiHealth = native && appRunning && uiUrl ? await fetch(`${uiUrl}/api/health`)
      .then(async (response) => response.ok ? await response.json() : null, () => null) : null;
    const ownsUi = !native || (typeof uiHealth?.runtime?.profilePath === 'string' && typeof instance.profile === 'string'
      && path.resolve(uiHealth.runtime.profilePath) === path.resolve(instance.profile));
    const fresh = native && ownsUi && uiUrl ? await fetch(`${uiUrl}/api/device/agent/connection`)
      .then(async (response) => response.ok ? (await response.json()).connection : null, () => null) : null;
    const connection = native ? fresh : null;
    const url = native && !ownsUi ? null : connection?.url ?? uiUrl;
    const headers = connection ? { authorization: `Bearer ${connection.token}` } : {};
    const get = (route) => url ? fetch(`${url}${route}`, { headers }).then((response) => response.ok ? response.json() : null, () => null) : null;
    const vault = await get('/api/vault/status');
    const search = await get('/api/search/status');
    const setup = native ? await get('/api/vault/setup') : null;
    const now = commitOf(instance.checkout);
    report.instance = {
      runDir: instance.runDir, url, data: instance.data, vault: instance.vault, pid: instance.pid,
      ...(native ? { uiUrl, connection: !appRunning ? 'app-not-running' : !ownsUi ? 'ui-profile-mismatch'
        : connection ? 'authenticated-agent-api' : 'ui-api-agent-unavailable', vaultSetupState: setup?.vault?.state ?? null } : {}),
      processes: processes.map((member) => member.pid),
      health: url ? await fetch(`${url}/api/health`, { headers }).then((response) => response.ok, () => false) : false,
      search: search?.status?.state ?? null,
      vaultPath: vault?.vaultPath ?? null,
      vaultInsideRun: Boolean(vault?.vaultPath?.startsWith(instance.runDir)),
      launchedCommit: instance.commit, checkoutCommit: now.commit,
      stale: now.commit !== instance.commit ? 'checkout moved to another commit since launch; relaunch to test the current code'
        : now.sourceHash !== instance.sourceHash ? 'checkout has uncommitted changes made after launch; relaunch to test them' : null,
    };
    const i = report.instance;
    const noVault = native ? setup?.vault?.state === 'not_ready' : instance.vault === 'none';
    healthy &&= i.processes.length > 0 && i.health && (noVault || (i.search === 'ready' && i.vaultInsideRun));
  }
  if (o.issue) report.evidence = { issue: o.issue, ...evidenceFreshness(evidenceDir(o.issue), { local: checkoutRoot() }) };
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
  await writeFile(state, JSON.stringify({ commit: instance.commit, dirty: instance.dirty, sourceHash: instance.sourceHash, route: o.route, takenAt: new Date().toISOString(), ...(await apiState(instance)) }, null, 2));
  print({ screenshot: png, state });
}

async function main() {
  const command = positionals[0];
  if (o.help || !command) { console.log(USAGE); return; }
  if (command === 'doctor') return doctor();
  if (command === 'launch') {
    if (!['synthetic', 'real'].includes(o.data) || !['selected', 'fixed', 'none'].includes(o.vault)) throw new Error(USAGE);
    const instance = await launchWeb({ issue: need('issue'), label: o.label, evidence: o.evidence, checkout: o.checkout, data: o.data, vault: o.vault, build: !o['no-build'] });
    const { api, catalog, updateCatalog, restart, state, stop, ...record } = instance;
    if (o.data === 'real') record.real = REAL;
    return print(record);
  }
  if (command === 'state') return print(await readState(need('run')));
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
  if (command === 'flows') {
    if (positionals[1] === 'list') {
      const listed = selectFlows(await listFlows(), { tier: o.tier, feature: o.feature === undefined ? undefined : findFeature(readFeatures(), o.feature) });
      return print(listed.map(({ name, title, tier, covers, desktop, overBudget }) => ({ name, title, tier, covers,
        ...(desktop ? { desktop } : {}), ...(overBudget ? { overBudget } : {}) })));
    }
    if (positionals[1] === 'history') return history();
    if (positionals[1] !== 'run') throw new Error(`flows needs list, run or history\n${USAGE}`);
    if (o.web && o.desktop) throw new Error('Choose only one of --web or --desktop');
    const outcome = await runFlows({ names: positionals.slice(2), issue: need('issue'), label: o.label, checkout: o.checkout,
      layer: o.web ? 'web' : o.desktop ? 'desktop' : 'all', tier: o.tier, feature: o.feature, jobs: /^\d+$/u.test(o.jobs) ? Number(o.jobs) : Number.NaN });
    print(outcome);
    if (!outcome.flows.every((flow) => flow.passed)) process.exitCode = 1;
    return;
  }
  if (command === 'summary') {
    const platforms = o.platform ?? [];
    if (platforms.some((platform) => !['darwin', 'win32'].includes(platform))) throw new Error(`--platform is darwin or win32\n${USAGE}`);
    if (positionals.length < 2) throw new Error(`summary needs results.json files\n${USAGE}`);
    const summary = summarize(readResults(positionals.slice(1)), { commit: need('commit'), platforms, scenarios: o.scenario ?? [] });
    print(summary);
    if (!summary.complete) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown command ${command}\n${USAGE}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

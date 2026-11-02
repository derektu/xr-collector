// What `verify.mjs doctor` reports: the machine, the checkout, the slots and, when asked, one run, a
// packaged app and an issue's evidence. Read-only; the command prints the report and exits 2 when it
// is not healthy.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { attach, portFree, runProcesses, slotHolders } from './instance.mjs';
import { checkoutRoot, commitOf, evidenceDir, SLOTS } from './paths.mjs';
import { environment, exe, WINDOWS } from './platform.mjs';
import { BIN_PLATFORM, desktopTarget, runtimeBin } from './target.mjs';
import { evidenceFreshness } from './freshness.mjs';

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
 * The doctor report for `checkout`. `app` is a packaged app to check, `electron` requires the
 * development Electron, `run` adds one run's instance, `issue` that issue's evidence. `chromiumPath`
 * is where Playwright keeps its Chromium; the command reads it from Playwright, which takes about a
 * second of CPU to load.
 */
export async function doctorReport({ checkout, app, electron = false, run, issue, chromiumPath }) {
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
    chromium: item(existsSync(chromiumPath), { path: chromiumPath, fix: `npx playwright install chromium${WINDOWS ? ' (Web mode, which runs on macOS only)' : ''}` }),
    runtimeBin: item(existsSync(bin), { path: bin, fix: `${download} (resources/bin/${BIN_PLATFORM})` }),
    meilisearch: item(existsSync(path.join(bin, exe('meilisearch'))), { path: path.join(bin, exe('meilisearch')), fix: download }),
    ytdlp: item(existsSync(path.join(bin, 'yt-dlp', exe('yt-dlp'))), { path: path.join(bin, 'yt-dlp', exe('yt-dlp')), fix: `${download} (needed by --data real and Electron)` }),
  };
  // Chromium serves Web mode only, which Windows does not run and a Desktop run (--app, --electron) does not use.
  const desktop = Boolean(app || electron);
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
    if (electron) required.push(need.check);
  }
  // Electron serves the checkout's dist/web; Web mode builds its own copy into the run.
  checks.electronWebCurrent = item(builtAfterSources(checkout), { fix: 'npm run build; Electron would show an older UI (Electron flows only)' });
  if (electron) required.push('electronWebCurrent');
  if (app) {
    for (const need of desktopNeeds(app)) {
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
  const report = { checkout, ...commitOf(checkout), environment: machine, ...(app ? { app: path.resolve(app) } : {}), missing, checks, slots, evidenceRoot: path.dirname(evidenceDir('x')) };
  let healthy = required.every((key) => checks[key].ok);
  if (run) {
    const stored = JSON.parse(await readFile(path.join(run, 'run.json'), 'utf8'));
    const native = stored.kind === 'electron';
    // Native UI driving stays with its owner. Its known UI origin exports the current Agent
    // connection on demand; run.json never acts as a credential snapshot or product discovery file.
    const instance = native ? stored : attach(run);
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
  if (issue) report.evidence = { issue, ...evidenceFreshness(evidenceDir(issue), { local: checkoutRoot() }) };
  report.healthy = healthy;
  return report;
}

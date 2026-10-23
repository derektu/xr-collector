// Native Desktop runs through Playwright's Electron mode, for scenarios that need Electron or the
// platform: native dialogs, preload bridge, window behaviour, shell.openExternal, restarts with the
// same profile, and the packaged app itself. The app starts in background validation mode
// (XR_COLLECTOR_VALIDATION_HIDDEN=1): no window, no focus, no Dock icon, while Playwright drives and
// screenshots the page.
//
// The target is the checkout's development Electron on its build (npm run build), or with `app` a
// packaged app (npm run package:mac). Playwright starts either one the same way, so a packaged run
// keeps the app's Electron fuses as shipped. The Electron main process assembles the product's real
// plugins, so YouTube here is real yt-dlp; synthetic YouTube exists only in Web mode. Synthetic feeds
// work when a Web instance of the same flow serves them, or any local HTTP server does.
//
// Electron runs only inside the flow process that launched it: Playwright closes it when that
// process exits.
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { checkoutRoot, claimEvidence, cleanEnv, commitOf, dropUnusedEvidence, processStart, runMarker } from './paths.mjs';
import { LOADED } from './drive.mjs';
import { createRun, releaseSlot, terminateRun, writeJsonAtomic } from './instance.mjs';
import { desktopTarget, requireTarget } from './target.mjs';

/** How a Desktop run's page and main process are reached; recorded in results.json as target.connection. */
const CONNECTION = 'playwright-electron';

/**
 * Prepares an isolated profile and launches the Desktop app hidden. Options: issue (required), label,
 * evidence (an explicit evidence folder, missing or empty; see claimEvidence), app (a packaged app;
 * the development Electron otherwise), checkout, vault ('selected' creates a Vault and selects it in
 * the profile, so moving and opening another Vault stay available, and needs the checkout's
 * dist/node; 'none' starts at Onboarding), size, hidden. Returns { app, window, ...record, relaunch(),
 * close() }; record.target names the program under test. relaunch() quits and starts again with the
 * same profile; close({ keep }) quits, copies the app's output into the evidence folder, releases the
 * slot and removes the scratch folder unless `keep`.
 */
export async function launchElectron({
  issue, label, evidence: explicitEvidence, app: appPath, checkout = checkoutRoot(), vault = 'selected', size = '1280x900', hidden = true,
} = {}) {
  if (!issue) throw new Error('launchElectron needs an issue (number or label) for the evidence folder');
  if (!['selected', 'none'].includes(vault)) throw new Error(`vault must be selected or none, not ${vault}`);
  checkout = path.resolve(checkout);
  const target = desktopTarget({ checkout, app: appPath });
  requireTarget(target);
  if (vault === 'selected' && !existsSync(path.join(checkout, 'dist', 'node', 'vault', 'vault-selection.js'))) {
    throw new Error(`vault: 'selected' writes the Vault with ${checkout}/dist/node; run npm run build there, or use vault: 'none' and choose the Vault through Onboarding`);
  }
  // A label already used gets the next free <label>-N folder; the record carries the one used.
  const claimed = claimEvidence(issue, label, { evidence: explicitEvidence });
  const evidence = claimed.evidence;
  label = claimed.label ?? undefined;
  let run;
  try {
    run = await createRun(issue, checkout, { label, suffix: '-electron' });
  } catch (error) {
    dropUnusedEvidence(claimed);
    throw error;
  }
  const { runDir, ports } = run;
  const profile = path.join(runDir, 'profile');
  const vaultPath = path.join(runDir, 'vault');
  const documents = path.join(runDir, 'documents');
  await mkdir(profile, { recursive: true });
  await mkdir(documents, { recursive: true });

  // The shell's own XR_COLLECTOR_* settings (a fixed Vault, ports) would break isolation.
  const env = {
    ...cleanEnv(),
    XR_COLLECTOR_PROFILE: profile,
    XR_COLLECTOR_AGENT_PORT: String(ports.agent),
    // Exports and backups keep the product's folder names, inside the run.
    XR_COLLECTOR_EXPORT_DIR: path.join(documents, 'XR Collector 匯出'),
    XR_COLLECTOR_BACKUP_DIR: path.join(documents, 'XR Collector 備份'),
    XR_COLLECTOR_VALIDATION_WINDOW_SIZE: size,
    ...(hidden ? { XR_COLLECTOR_VALIDATION_HIDDEN: '1' } : {}),
  };
  // run.json names this flow process as the holder, so sweep and stop leave a live run alone. The
  // run marker on the app's command line lets them find an app the flow left behind.
  const record = {
    kind: 'electron', issue: String(issue), ...(label ? { label: String(label) } : {}), runDir, evidence, checkout, ...commitOf(checkout),
    profile, vault: vault === 'selected' ? vaultPath : null, documents, ports,
    pid: process.pid, start: processStart(process.pid), data: 'real', layer: '原生 Desktop（Playwright _electron）',
    target: { kind: target.kind, app: target.app, executable: target.executable, version: null, platform: process.platform, arch: null, connection: CONNECTION },
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(runDir, 'run.json'), record);
  const log = path.join(runDir, 'server.log');

  const start = async () => {
    const app = await electron.launch({
      executablePath: target.executable, args: [...target.args, runMarker(runDir)], cwd: target.cwd, env, timeout: 90_000,
    });
    // The runtime runs in the main process, so its output is the run's server log.
    const output = createWriteStream(log, { flags: 'a' });
    app.process().stdout?.pipe(output);
    app.process().stderr?.pipe(output);
    const window = await app.firstWindow({ timeout: 90_000 });
    await window.locator(LOADED).first().waitFor({ timeout: 90_000 });
    return { app, window };
  };
  let current;
  try {
    if (vault === 'selected') {
      const load = (relative) => import(pathToFileURL(path.join(checkout, 'dist', 'node', relative)).href);
      const { createVaultDirectory } = await load('vault/vault-directory.js');
      const { VaultSelection } = await load('vault/vault-selection.js');
      await createVaultDirectory(vaultPath, 'XR Collector (verify skill, Electron)');
      await new VaultSelection(path.join(profile, 'vault-selection.json')).write(vaultPath);
    }
    current = await start();
    // The program reports its own version and architecture, the same way for both kinds of target.
    Object.assign(record.target, await current.app.evaluate(({ app }) => ({ version: app.getVersion(), arch: process.arch })));
    writeJsonAtomic(path.join(runDir, 'run.json'), record);
  } catch (error) {
    try { await current?.app.close(); } catch { /* already closed */ }
    await terminateRun(runDir);
    releaseSlot(ports.slot, runDir);
    dropUnusedEvidence(claimed);
    throw error;
  }
  const handle = {
    ...record,
    get app() { return current.app; },
    get window() { return current.window; },
    /** Quits through the app's own shutdown path and starts again with the same profile. */
    async relaunch() { await current.app.close(); await terminateRun(runDir); current = await start(); return current; },
    /**
     * Quits, ends whatever the app left running (a Meilisearch after an Electron crash), copies the
     * app's output into the evidence folder, releases the slot.
     */
    async close({ keep = false } = {}) {
      try { await current.app.close(); } catch { /* already closed */ }
      await terminateRun(runDir);
      if (existsSync(log)) await copyFile(log, path.join(evidence, `${path.basename(runDir)}-server.log`));
      releaseSlot(ports.slot, runDir);
      if (!keep) await rm(runDir, { recursive: true, force: true });
    },
  };
  return handle;
}

/**
 * Answers the native open/save dialogs in the main process with `answers.open` / `answers.save`
 * (paths inside the run folder) and records each call's options in globalThis.__dialogCalls.
 */
export async function stubDialogs(app, answers) {
  await app.evaluate(({ dialog }, { open, save }) => {
    globalThis.__dialogCalls = [];
    dialog.showOpenDialog = async (...args) => {
      globalThis.__dialogCalls.push({ kind: 'open', options: args.at(-1) });
      return open ? { canceled: false, filePaths: [open] } : { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      globalThis.__dialogCalls.push({ kind: 'save', options: args.at(-1) });
      return save ? { canceled: false, filePath: save } : { canceled: true };
    };
  }, answers);
}

/** Replaces shell.openExternal with a recorder; returns a reader of the recorded URLs. */
export async function recordOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__openedExternal = [];
    shell.openExternal = async (url) => { globalThis.__openedExternal.push(url); };
  });
  return () => app.evaluate(() => globalThis.__openedExternal);
}

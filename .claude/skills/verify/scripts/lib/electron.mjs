// Native Desktop runs through Playwright's Electron mode, for scenarios that need Electron or the
// platform: native dialogs, preload bridge, window behaviour, shell.openExternal, restarts with the
// same profile. The app starts in background validation mode (XR_COLLECTOR_VALIDATION_HIDDEN=1): no
// window, no focus, no Dock icon, while Playwright drives and screenshots the page.
//
// The Electron main process assembles the product's real plugins, so YouTube here is real yt-dlp;
// synthetic YouTube exists only in Web mode. Synthetic feeds work when a Web instance of the same
// flow serves them, or any local HTTP server does.
//
// The checkout must be built (npm run build) and have resources/bin/mac. Electron runs only inside
// the flow process that launched it: Playwright closes it when that process exits.
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { checkoutRoot, commitOf, evidenceDir, runsRoot } from './paths.mjs';
import { claimSlot, releaseSlot } from './instance.mjs';

const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);

/**
 * Prepares an isolated profile with a selected Vault (so moving and opening another Vault stay
 * available) and launches the Desktop app hidden. Returns { app, window, ...record, relaunch(), close() }.
 * relaunch() quits and starts again with the same profile; close({ keep }) quits, releases the slot
 * and removes the scratch folder unless `keep`.
 */
export async function launchElectron({ issue, checkout = checkoutRoot(), size = '1280x900', hidden = true } = {}) {
  if (!issue) throw new Error('launchElectron needs an issue (number or label) for the evidence folder');
  checkout = path.resolve(checkout);
  const executable = path.join(checkout, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  for (const file of [executable, path.join(checkout, 'dist', 'node', 'electron', 'main.js'), path.join(checkout, 'resources', 'bin', 'mac', 'meilisearch')]) {
    if (!existsSync(file)) throw new Error(`Missing ${file}; run npm run build and npm run download:runtime in the checkout`);
  }
  const runDir = path.join(runsRoot(checkout), `${issue}-${stamp()}-electron`);
  const profile = path.join(runDir, 'profile');
  const vault = path.join(runDir, 'vault');
  const evidence = evidenceDir(issue, checkout);
  await mkdir(profile, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const ports = await claimSlot(runDir);

  const load = (relative) => import(pathToFileURL(path.join(checkout, 'dist', 'node', relative)).href);
  const { createVaultDirectory } = await load('vault/vault-directory.js');
  const { VaultSelection } = await load('vault/vault-selection.js');
  await createVaultDirectory(vault, 'XR Collector (verify skill, Electron)');
  await new VaultSelection(path.join(profile, 'vault-selection.json')).write(vault);

  const env = {
    ...process.env,
    XR_COLLECTOR_PROFILE: profile,
    XR_COLLECTOR_AGENT_PORT: String(ports.agent),
    XR_COLLECTOR_EXPORT_DIR: path.join(runDir, 'documents', 'XR Collector Exports'),
    XR_COLLECTOR_BACKUP_DIR: path.join(runDir, 'documents', 'XR Collector Backups'),
    XR_COLLECTOR_VALIDATION_WINDOW_SIZE: size,
    ...(hidden ? { XR_COLLECTOR_VALIDATION_HIDDEN: '1' } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const record = { issue: String(issue), runDir, evidence, checkout, ...commitOf(checkout), profile, vault, ports, data: 'real', layer: '原生 Desktop（Playwright _electron）' };

  const start = async () => {
    const app = await electron.launch({ executablePath: executable, args: ['.'], cwd: checkout, env, timeout: 90_000 });
    const window = await app.firstWindow({ timeout: 90_000 });
    await window.locator('[data-testid^="page-"]').first().waitFor({ timeout: 90_000 });
    return { app, window };
  };
  let current = await start();
  const handle = {
    ...record,
    get app() { return current.app; },
    get window() { return current.window; },
    /** Quits through the app's own shutdown path and starts again with the same profile. */
    async relaunch() { await current.app.close(); current = await start(); return current; },
    async close({ keep = false } = {}) {
      try { await current.app.close(); } catch { /* already closed */ }
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

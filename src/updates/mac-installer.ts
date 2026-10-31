import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError, type BuildInfo, type UpdateOffer } from '../core/types.js';
import type { NativeInstaller, NativeInstallRecovery, NativeRecoveryResult, PreparedInstall } from './types.js';
import yauzl from 'yauzl';

const execFile = promisify(execFileCallback);
const updateWorkName = /^\.xr-update-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const launchKeys = ['XR_COLLECTOR_PROFILE', 'XR_COLLECTOR_VAULT', 'XR_COLLECTOR_AGENT_PORT', 'XR_COLLECTOR_VALIDATION_HIDDEN',
  'XR_COLLECTOR_VALIDATION_CONTROL', 'XR_COLLECTOR_VALIDATION_WINDOW_SIZE', 'XR_COLLECTOR_UPDATE_BASE_URL',
  'XR_COLLECTOR_EXPORT_DIR', 'XR_COLLECTOR_BACKUP_DIR'] as const;

/** Unprivileged two-phase macOS App replacement. The Swift helper owns swap, launch verification and rollback. */
export class MacNativeInstaller implements NativeInstaller {
  readonly available: boolean;
  constructor(private readonly options: { packaged: boolean; resourcesPath: string; executablePath: string; current: BuildInfo }) {
    this.available = process.platform === 'darwin' && options.packaged;
  }
  async validate(offer: UpdateOffer, packageFile: string): Promise<void> {
    if (!this.available || offer.target !== 'darwin-arm64' || !packageFile.endsWith('.zip')) throw new CollectorError('update_install_unavailable', '這份更新不能由目前的 macOS App 安裝。');
    await stat(this.helper()).catch((error) => { throw new CollectorError('update_install_unavailable', 'macOS 更新 helper 不存在。', { cause: error }); });
  }
  async prepare(offer: UpdateOffer, packageFile: string, signal: AbortSignal): Promise<PreparedInstall> {
    await this.validate(offer, packageFile);
    if (signal.aborted) throw signal.reason;
    const currentApp = enclosingApp(this.options.executablePath);
    const parent = path.dirname(currentApp);
    const runId = randomUUID(); const nonce = randomBytes(32).toString('hex');
    const workDir = path.join(parent, `.xr-update-${runId}`); await mkdir(workDir, { mode: 0o700 });
    let child: ReturnType<typeof spawn> | null = null;
    try {
      await validateMacUpdateArchive(packageFile);
      const unpacked = path.join(workDir, 'unpacked'); await mkdir(unpacked, { mode: 0o700 });
      await execFile('/usr/bin/ditto', ['-x', '-k', packageFile, unpacked], { signal });
      const apps = (await readdir(unpacked)).filter((entry) => entry.endsWith('.app'));
      if (apps.length !== 1) throw new CollectorError('update_integrity_failed', 'macOS 更新檔必須只包含一個 App。');
      const stagedApp = path.join(workDir, 'stage.app'); await rename(path.join(unpacked, apps[0]!), stagedApp);
      const bundleId = (await execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(currentApp, 'Contents', 'Info.plist')])).stdout.trim();
      const startedAt = (await execFile('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
      const launchEnvironment = Object.fromEntries(launchKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!] as const]));
      const request = { schemaVersion: 1, runId, nonce, parentPid: process.pid, parentStartedAt: startedAt, currentApp, stagedApp, workDir,
        expectedBundleId: bundleId, previousVersion: this.options.current.version, previousBuildId: this.options.current.buildId,
        expectedVersion: offer.version, expectedBuildId: offer.buildInfo.buildId, expectedTarget: offer.target,
        launchEnvironment, timeoutMs: 120_000 };
      const requestFile = path.join(workDir, 'request.json'); await writeOwnedJson(requestFile, request);
      child = spawn(this.helper(), ['--request', requestFile], { detached: false, stdio: 'ignore' });
      const ownedChild = child;
      const abort = () => { void writeOwnedJson(path.join(workDir, 'abort.json'), { schemaVersion: 1, runId, nonce }).catch(() => undefined); };
      signal.addEventListener('abort', abort, { once: true });
      try { await waitForSpawn(ownedChild); }
      catch (error) {
        signal.removeEventListener('abort', abort); await rm(workDir, { recursive: true, force: true });
        throw new CollectorError('update_install_unavailable', '無法啟動 macOS 更新 helper。', { cause: error as Error });
      }
      try { await waitForPhase(path.join(workDir, 'result.json'), 'prepared', ownedChild, signal, 30_000); }
      catch (error) { abort(); if (await waitForExit(ownedChild, 5_000)) await rm(workDir, { recursive: true, force: true }); throw error; }
      return preparedMacHandoff({ workDir, runId, nonce, parentPid: process.pid, expectedVersion: offer.version,
        expectedBuildId: offer.buildInfo.buildId, child: ownedChild, signal, abort });
    } catch (error) {
      if (!child) await rm(workDir, { recursive: true, force: true });
      throw error;
    }
  }
  recover(): Promise<NativeRecoveryResult> { return recoverMacUpdateResults(this.options.resourcesPath, this.options.current); }
  private helper(): string { return path.join(this.options.resourcesPath, 'bin', 'xr-mac-update-helper'); }
}

/** @internal Exported so the cross-process protocol can be tested without constructing an App bundle. */
export function preparedMacHandoff(options: {
  workDir: string;
  runId: string;
  nonce: string;
  parentPid: number;
  expectedVersion: string;
  expectedBuildId: string;
  child: ReturnType<typeof spawn>;
  signal: AbortSignal;
  abort: () => void;
}): PreparedInstall {
  let finished = false; let handoffWritten = false;
  return {
    recoveryToken: options.runId,
    handoff: async () => {
      if (finished) return;
      await requireHelperPhase(path.join(options.workDir, 'result.json'), 'prepared', options.child);
      await writeOwnedJson(path.join(options.workDir, 'handoff.json'), {
        schemaVersion: 1, runId: options.runId, nonce: options.nonce, parentPid: options.parentPid,
        expectedVersion: options.expectedVersion, expectedBuildId: options.expectedBuildId,
      });
      handoffWritten = true;
      await waitForPhase(path.join(options.workDir, 'result.json'), 'waiting_for_exit', options.child, options.signal, 30_000,
        'macOS 更新 helper 未確認安裝交接。');
      finished = true; options.signal.removeEventListener('abort', options.abort); options.child.unref();
    },
    cancel: async () => {
      if (finished) return;
      finished = true; options.signal.removeEventListener('abort', options.abort);
      // A committed handoff cannot be cancelled by writing a later abort. The helper owns recovery.
      if (!handoffWritten) options.abort();
      if (await waitForExit(options.child, 5_000) && !handoffWritten) {
        await rm(options.workDir, { recursive: true, force: true });
      }
    },
  };
}

export async function acknowledgeMacUpdateLaunch(current: BuildInfo): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const context = (await trustedUpdateContexts()).find(({ request }) => request.expectedVersion === current.version && request.expectedBuildId === current.buildId);
  if (!context) return false;
  const { workDir, request } = context; const nonce = String(request.nonce);
  const startedAt = (await execFile('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
  await writeOwnedJson(path.join(workDir, 'ack.json'), { schemaVersion: 1, runId: request.runId, nonce, version: current.version,
    buildId: current.buildId, pid: process.pid, launchedStartedAt: startedAt });
  process.env.XR_COLLECTOR_UPDATE_RUN = workDir; process.env.XR_COLLECTOR_UPDATE_NONCE = nonce;
  return true;
}

/**
 * Records that replacement B closed its update service and Collector runtime cleanly. The helper
 * requires this exact-process receipt before it may terminate B and restore A; absence is a
 * recovery-required result, never permission to run two Collectors against one profile.
 */
export async function acknowledgeMacUpdateShutdown(current: BuildInfo): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const context = (await trustedUpdateContexts()).find(({ request }) => request.expectedVersion === current.version
    && request.expectedBuildId === current.buildId);
  if (!context) return false;
  const startedAt = (await execFile('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
    env: { ...process.env, LC_ALL: 'C' },
  })).stdout.trim();
  await writeOwnedJson(path.join(context.workDir, 'shutdown-safe.json'), {
    schemaVersion: 1, runId: context.request.runId, nonce: context.request.nonce,
    pid: process.pid, startedAt, version: current.version, buildId: current.buildId,
  });
  return true;
}

/** Finishes an interrupted helper and returns receipts without deleting them. */
export async function recoverMacUpdateResults(
  resourcesPath: string,
  current: BuildInfo,
  dependencies: {
    platform?: NodeJS.Platform;
    contexts?: () => Promise<Array<{ workDir: string; request: Record<string, unknown> }>>;
    runHelper?: (helper: string, requestFile: string) => Promise<void>;
  } = {},
): Promise<NativeRecoveryResult> {
  if ((dependencies.platform ?? process.platform) !== 'darwin') return { launchReady: true, results: [] };
  const contexts = await (dependencies.contexts ?? trustedUpdateContexts)();
  if (contexts.length === 0) return { launchReady: true, results: [] };
  const results: NativeInstallRecovery[] = []; let launchReady = true; let foundCurrent = false;
  for (const { workDir, request } of contexts) {
    const contextIsCurrent = requestMatchesCurrent(request, current);
    const selectedContext = !foundCurrent && contextIsCurrent;
    if (selectedContext) { foundCurrent = true; launchReady = false; }
    const resultFile = path.join(workDir, 'result.json'); const requestFile = path.join(workDir, 'request.json');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const phase = await readFile(resultFile, 'utf8').then((text) => (JSON.parse(text) as { phase?: string }).phase).catch(() => undefined);
      if (isTerminalRecoveryPhase(phase)) {
        if (phase !== 'recovery_required' || !contextIsCurrent
          || request.expectedVersion !== current.version || request.expectedBuildId !== current.buildId
          || !await hasLateAcknowledgement(workDir, request)) break;
        await (dependencies.runHelper ?? runRecoveryHelper)(path.join(resourcesPath, 'bin', 'xr-mac-update-helper'), requestFile);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const afterWait = await readFile(resultFile, 'utf8').then((text) => (JSON.parse(text) as { phase?: string }).phase).catch(() => undefined);
      if (isTerminalRecoveryPhase(afterWait)) continue;
      await (dependencies.runHelper ?? runRecoveryHelper)(path.join(resourcesPath, 'bin', 'xr-mac-update-helper'), requestFile);
    }
    const raw = await readFile(resultFile, 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
    const recovery = raw && nativeRecoveryReceipt(workDir, request, raw, resourcesPath);
    if (!recovery) continue;
    results.push(recovery);
    if (selectedContext && recoveryMatchesCurrent(recovery, current)) {
      launchReady = recovery.phase !== 'recovery_required';
    }
  }
  return { launchReady, results };
}

async function hasLateAcknowledgement(workDir: string, request: Record<string, unknown>): Promise<boolean> {
  const ack = await readFile(path.join(workDir, 'ack.json'), 'utf8')
    .then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
  return Boolean(ack && ack.schemaVersion === 1 && ack.runId === request.runId && ack.nonce === request.nonce
    && ack.version === request.expectedVersion && ack.buildId === request.expectedBuildId
    && typeof ack.pid === 'number' && Number.isInteger(ack.pid) && ack.pid > 0 && typeof ack.launchedStartedAt === 'string');
}

async function runRecoveryHelper(helper: string, requestFile: string): Promise<void> {
  const child = spawn(helper, ['--recover', requestFile], { stdio: 'ignore' });
  await new Promise<void>((resolve) => { child.once('error', () => resolve()); child.once('exit', () => resolve()); });
}

/**
 * Prepares rollback when replacement B reached this process but startup failed before it could
 * acknowledge readiness. The helper validates and locks the owned journal, then waits for this
 * exact B process to exit before exchanging bundles; callers must exit only after `true`.
 */
export async function prepareMacUpdateRollback(resourcesPath: string, current: BuildInfo): Promise<{ workDir: string } | null> {
  if (process.platform !== 'darwin') return null;
  const context = (await trustedUpdateContexts()).find(({ request }) => request.expectedVersion === current.version
    && request.expectedBuildId === current.buildId);
  if (!context) return null;
  const requestFile = path.join(context.workDir, 'request.json');
  const child = spawn(path.join(resourcesPath, 'bin', 'xr-mac-update-helper'), ['--rollback', requestFile], { detached: false, stdio: 'ignore' });
  try {
    await waitForSpawn(child);
    await waitForPhase(path.join(context.workDir, 'result.json'), 'rollback_prepared', child, new AbortController().signal, 30_000);
    child.unref();
    return { workDir: context.workDir };
  } catch {
    // An already-running owned helper may hold the journal and complete its own rollback. Never
    // compete with it or infer success from a lock failure/early exit.
    return null;
  }
}

async function trustedUpdateContexts(): Promise<Array<{ workDir: string; request: Record<string, unknown> }>> {
  const currentApp = enclosingApp(process.execPath); const parent = path.dirname(currentApp);
  const explicit = process.env.XR_COLLECTOR_UPDATE_RUN;
  const candidates = explicit ? [explicit] : (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && updateWorkName.test(entry.name)).map((entry) => path.join(parent, entry.name));
  const trusted: Array<{ workDir: string; request: Record<string, unknown>; modified: number }> = [];
  for (const workDir of candidates.slice(0, 32)) {
    try {
      const attributes = await lstat(workDir);
      if (!updateWorkName.test(path.basename(workDir)) || path.dirname(workDir) !== parent || await realpath(workDir) !== workDir
        || attributes.isSymbolicLink() || !attributes.isDirectory()
        || attributes.uid !== process.getuid?.() || (attributes.mode & 0o077) !== 0) continue;
      const request = JSON.parse(await readFile(path.join(workDir, 'request.json'), 'utf8')) as Record<string, unknown>;
      if (request.workDir !== workDir || request.currentApp !== currentApp || typeof request.runId !== 'string' || typeof request.nonce !== 'string'
        || !/^[a-f0-9]{64}$/u.test(request.nonce) || explicit && request.nonce !== process.env.XR_COLLECTOR_UPDATE_NONCE) continue;
      trusted.push({ workDir, request, modified: attributes.mtimeMs });
    } catch { /* A stale or partial owned attempt is ignored; the helper validates again before recovery. */ }
  }
  return trusted.sort((left, right) => right.modified - left.modified).map(({ workDir, request }) => ({ workDir, request }));
}

function isTerminalRecoveryPhase(value: unknown): value is NativeInstallRecovery['phase'] {
  return ['succeeded', 'rolled_back', 'failed', 'recovery_required'].includes(String(value));
}

/** @internal Builds a receipt without consuming or deleting its journal. */
export function nativeRecoveryReceipt(
  workDir: string,
  request: Record<string, unknown>,
  result: Record<string, unknown>,
  resourcesPath: string,
): NativeInstallRecovery | null {
  const phase = result.phase;
  if (result.schemaVersion !== 1 || !isTerminalRecoveryPhase(phase) || result.runId !== request.runId || typeof request.runId !== 'string'
    || typeof request.previousVersion !== 'string' || typeof request.previousBuildId !== 'string'
    || typeof request.expectedVersion !== 'string' || typeof request.expectedBuildId !== 'string') return null;
  const requestFile = path.join(workDir, 'request.json');
  return {
    token: request.runId, phase,
    previousVersion: request.previousVersion, previousBuildId: request.previousBuildId,
    expectedVersion: request.expectedVersion, expectedBuildId: request.expectedBuildId,
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
    finalize: async () => {
      if (phase === 'recovery_required') throw new CollectorError('update_apply_failed', '需要人工復原的 macOS 更新紀錄不可自動清除。');
      let lastExit: number | null = null;
      // A replacement helper may have written the terminal receipt just before releasing its lock.
      // Retry only the exact cleanup command briefly; every failed attempt leaves the journal intact.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const child = spawn(path.join(resourcesPath, 'bin', 'xr-mac-update-helper'), ['--cleanup', requestFile], { stdio: 'ignore' });
        await waitForSpawn(child); lastExit = await waitForChildExit(child);
        const remains = await stat(workDir).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false; throw error;
        });
        if (!remains) return;
        if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new CollectorError('update_apply_failed', `macOS 更新 helper 未清除已消費的紀錄（${lastExit ?? 'signal'}）。`);
    },
  };
}

function recoveryMatchesCurrent(result: NativeInstallRecovery, current: BuildInfo): boolean {
  return result.phase === 'succeeded'
    ? current.version === result.expectedVersion && current.buildId === result.expectedBuildId
    : current.version === result.previousVersion && current.buildId === result.previousBuildId;
}

function requestMatchesCurrent(request: Record<string, unknown>, current: BuildInfo): boolean {
  return request.expectedVersion === current.version && request.expectedBuildId === current.buildId
    || request.previousVersion === current.version && request.previousBuildId === current.buildId;
}

function enclosingApp(executable: string): string {
  const marker = '.app/Contents/MacOS/'; const index = executable.lastIndexOf(marker);
  if (index < 0) throw new CollectorError('update_install_unavailable', '目前程序不在 macOS App bundle。');
  return executable.slice(0, index + 4);
}
async function writeOwnedJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, file);
}
async function requireHelperPhase(file: string, expected: string, child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) throw new CollectorError('update_apply_failed', `macOS 更新 helper 已結束（${child.exitCode}）。`);
  const value = await readFile(file, 'utf8').then((text) => JSON.parse(text) as { phase?: string; reason?: string })
    .catch((error: NodeJS.ErrnoException) => { throw new CollectorError('update_apply_failed', '無法確認 macOS 更新 helper 狀態。', { cause: error }); });
  if (value.phase !== expected) throw new CollectorError('update_apply_failed', value.reason ?? `macOS 更新 helper 狀態不是 ${expected}。`);
}
async function waitForPhase(
  file: string,
  expected: string,
  child: ReturnType<typeof spawn>,
  signal: AbortSignal,
  timeout: number,
  timeoutMessage = 'macOS 更新 helper 準備逾時。',
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    if (child.exitCode !== null) throw new CollectorError('update_apply_failed', `macOS 更新 helper 已結束（${child.exitCode}）。`);
    try { const value = JSON.parse(await readFile(file, 'utf8')) as { phase?: string; error?: string };
      if (value.phase === expected) return; if (value.phase === 'failed') throw new CollectorError('update_apply_failed', value.error ?? 'macOS 更新 helper 準備失敗。');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof CollectorError) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new CollectorError('update_apply_failed', timeoutMessage);
}
async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve(code)); child.once('error', reject);
  });
}
async function waitForExit(child: ReturnType<typeof spawn>, timeout: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeout);
    const done = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); child.removeListener('exit', done); child.removeListener('error', done); };
    child.once('exit', done); child.once('error', done);
  });
}
async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid) return;
  return new Promise((resolve, reject) => {
    const spawned = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { child.removeListener('spawn', spawned); child.removeListener('error', failed); };
    child.once('spawn', spawned); child.once('error', failed);
  });
}

/** Rejects path traversal, case collisions and escaping symlinks before ditto writes any entry. */
export async function validateMacUpdateArchive(file: string): Promise<void> {
  const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true })
    .catch((error) => { throw new CollectorError('update_integrity_failed', 'macOS 更新檔不是有效的 zip。', { cause: error }); });
  try {
    if (zip.entryCount > 100_000) throw new CollectorError('update_integrity_failed', 'macOS 更新檔的項目過多。');
    const names = new Set<string>(); const entryPaths: string[] = []; const symlinks = new Set<string>(); let root: string | null = null; let total = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName; const directory = name.endsWith('/'); const parts = name.split('/').filter(Boolean);
      if (!name || name.includes('\\') || name.includes('\0') || name.includes('//') || name.startsWith('/') || parts.length === 0 || parts.some((part) => part === '.' || part === '..')
        || entry.isEncrypted() || !entry.canDecodeFileData()) throw new CollectorError('update_integrity_failed', 'macOS 更新檔含有不安全的路徑。');
      const folded = name.toLocaleLowerCase('en-US');
      if (names.has(folded)) throw new CollectorError('update_integrity_failed', 'macOS 更新檔含有重複路徑。');
      names.add(folded); entryPaths.push(name.replace(/\/$/u, ''));
      root ??= parts[0]!;
      if (parts[0] !== root || !root.endsWith('.app')) throw new CollectorError('update_integrity_failed', 'macOS 更新檔必須只包含一個 App。');
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > 4 * 1024 * 1024 * 1024) throw new CollectorError('update_integrity_failed', 'macOS 更新檔解壓後過大。');
      const mode = entry.externalFileAttributes >>> 16;
      if (!directory && (mode & 0o170000) === 0o120000) {
        if (entry.uncompressedSize > 4096) throw new CollectorError('update_integrity_failed', 'macOS 更新檔含有不安全的符號連結。');
        const target = (await readZipEntry(zip, entry)).toString('utf8');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (!target || target.includes('\\') || target.includes('\0') || target.startsWith('/') || target.split('/').includes('..')
          || resolved === '..' || resolved.startsWith('../') || resolved.split('/')[0] !== root) {
          throw new CollectorError('update_integrity_failed', 'macOS 更新檔含有離開 App 的符號連結。');
        }
        symlinks.add(name);
      }
    }
    for (const name of entryPaths) {
      const parts = name.split('/');
      for (let length = 1; length < parts.length; length += 1) {
        if (symlinks.has(parts.slice(0, length).join('/'))) throw new CollectorError('update_integrity_failed', 'macOS 更新檔不能在符號連結下寫入檔案。');
      }
    }
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw new CollectorError('update_integrity_failed', 'macOS 更新檔已損壞。', { cause: error as Error });
  } finally { zip.close(); }
}
async function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await zip.openReadStreamPromise(entry) as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Collector } from '../core/collector.js';
import {
  CollectorError, type ExportSuggestion, type ImportChoice, type ImportCounts, type ImportMode, type ImportPreview, type JobStopKind,
  type MoveCheck, type SyncPointSummary, type TransferOperation, type TransferResult, type TransferStatus, type TranscriptSearch,
} from '../core/types.js';
import { ChannelCollector } from '../channels/channel-collector.js';
import { ChannelScheduler } from '../channels/channel-scheduler.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../channels/json-channel-schedule-store.js';
import { canonicalJson } from '../channels/subscription-files.js';
import { JobManager, type JobLimits, type RetryPolicy } from '../jobs/job-manager.js';
import type { YouTubePacing } from '../capture/youtube-gate.js';
import { JobStore } from '../jobs/job-store.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { youtubeSource, type YouTubeCapture, type YouTubeChannelSource } from '../sources/youtube/adapter.js';
import { MarkdownVault } from './markdown-vault.js';
import { deletionId } from './deleted-documents.js';
import { machineName, readSyncHistory, sharedPoint, SYNC_FILE, syncFileBytes, syncSummary, type SyncHistory } from './sync-points.js';
import { chosenKeys, compareItems, itemStates, planChanges, syncItems, type Comparison, type ItemStates } from './vault-sync.js';
import { applyInPlace, checkFreeSpace, finishInPlaceImports, importedPoint, type ImportFault } from './vault-import.js';
import {
  checkPackageContent, openPackage, registeredFiles, registeredSource, writePackage, type PackageReader, type PackageSync, type WrittenPackage,
} from './vault-package.js';
import { documentIdFromPath } from './document-paths.js';
import {
  checkExportFile, checkPackageFile, exportFileName, isWithin, isWorkFolder, markerDigest, preImportFileName, recoverImport, writeAtomically,
} from './transfer-files.js';
import { inspectVaultDirectory, readVaultId } from './vault-directory.js';
import {
  belongsToMove, checkMoveTarget, clearMoveJournal, copyTree, formatBytes, hasMoveJournal, moveMargin, movingFolder, nearestExisting, previousLocations,
  recordPreviousLocation, recoverMove, removeOriginal, scanVault, treeBytes, verifyTree, writeMoveJournal, type MoveJournal, type StatFs,
} from './vault-move.js';
import type { VaultSelection } from './vault-selection.js';

interface Bundle {
  root: string;
  /** ID from the Vault's marker. */
  vaultId: string;
  collector: Collector;
  channels: ChannelCollector;
  jobs: JobManager;
  schedule: ChannelScheduler;
  runtime: SearchRuntime;
}
export interface WorkspaceOptions {
  /** Absolute path of a Vault that the caller has already inspected. */
  root: string;
  /** Device record of the active Vault; writing it is the commit point of a move or switch. */
  selection: VaultSelection;
  /**
   * Device profile folder: the journals of a move or an import from Onboarding in progress, and the
   * locations each Vault was moved from live here.
   */
  profilePath: string;
  /** Folder exports go to when no other place is chosen, and where an import exports the Vault before it applies. */
  exportFolder: string;
  /** Name of this machine in exports and conflicts; defaults to `machineName()`. */
  machineName?: string;
  /** How long a transfer waits for running collection steps; defaults to the job manager's limit. */
  holdTimeoutMs?: number;
  /** Application name and version written into markers of Vaults it creates. */
  createdBy: string;
  capture: YouTubeCapture;
  channelSource: YouTubeChannelSource;
  searchBinary: string;
  searchData: string;
  searchPort?: number;
  createSearch?: (root: string) => Promise<SearchRuntime>;
  /** Device record of collection jobs; defaults to an in-memory store. */
  jobStore?: JobStore;
  jobLimits?: Partial<JobLimits>;
  /** The device's YouTube request channel shared by the capture and channel source above. */
  pacing?: YouTubePacing;
  jobRetry?: Partial<RetryPolicy>;
  /**
   * The Vault location was fixed when the app started (`XR_COLLECTOR_VAULT`). The next start opens
   * that location again, so the Vault is neither moved nor switched for another one.
   */
  fixedLocation?: boolean;
  /** Free space of a volume; defaults to `fs.statfs`. */
  statfs?: StatFs;
  /**
   * Called at each step of a move; for tests that make a step fail (by throwing) or stop there
   * (by never settling). `copying` is called after each copied entry with its count.
   */
  moveFaults?: (phase: MoveFault, count?: number) => void | Promise<void>;
  /** Called at each step of an in-place import, for tests that make a step fail or stop there; see `ImportFault`. */
  importFaults?: (phase: ImportFault, count?: number) => void | Promise<void>;
}

/**
 * Steps of a move a test can stop at. `selected` comes right after the device selection names the
 * new location and before the journal records the switch.
 */
export type MoveFault = 'copying' | 'copied' | 'verified' | 'placed' | 'prepared' | 'committing' | 'selected' | 'committed' | 'cleaning';

/** How long `checkMove` reuses the size of the active Vault while a person types a location. */
const SIZE_REUSE_MS = 60_000;

/**
 * An import comparison waiting to be applied: the export file it compared, what it found, and a
 * digest of the local items, the shared sync point and the file it stands on.
 */
interface Preview { value: ImportPreview; comparison: Comparison; baseline: string; file: string; identity: string }

/** Service references stay stable for both UI and Agent while the active vault changes. */
export function forwarding<T extends object>(target: () => T): T {
  return new Proxy({} as T, {
    get(_object, key) {
      const object = target();
      const value: unknown = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export class VaultWorkspace {
  private current!: Bundle;
  private preview: Preview | null = null;
  private locked = false;
  private mergeWriting = false;
  private requests = 0;
  private operation: Promise<void> | null = null;
  /** Lifts the collection hold of the running transfer. */
  private releaseJobs: (() => void) | null = null;
  /** Cancels the running transfer while it waits for collection; null once it has started its work. */
  private waitAbort: AbortController | null = null;
  private lastSync: SyncPointSummary | null = null;
  private statusValue: Omit<TransferStatus, 'vaultPath' | 'lastSync' | 'relocationUnavailable'> = {
    state: 'idle', operation: null, message: '', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
  };
  readonly collector = forwarding(() => this.current.collector);
  readonly channels = forwarding(() => this.current.channels);
  readonly jobs = forwarding(() => this.current.jobs);
  readonly schedule = forwarding(() => this.current.schedule);
  readonly search = forwarding<TranscriptSearch>(() => this.current.runtime.search);
  private readonly jobStore: JobStore;
  private readonly holdTimeoutMs: number | undefined;
  /** Locations the active Vault was moved from; activity recorded there without a Vault ID is its own. */
  private previousPaths: string[] = [];
  /** Size of the active Vault from the last move check, reused briefly so typing a location stays cheap. */
  private sizeCache: { root: string; bytes: number; at: number } | null = null;

  private constructor(private readonly options: WorkspaceOptions) {
    this.jobStore = options.jobStore ?? JobStore.memory();
    this.holdTimeoutMs = options.holdTimeoutMs;
    this.machine = options.machineName ?? machineName();
  }
  private readonly machine: string;

  static async open(options: WorkspaceOptions): Promise<VaultWorkspace> {
    const workspace = new VaultWorkspace(options);
    const root = options.root;
    const selected = await options.selection.read().catch(() => null);
    // The selected Vault and the one being opened are never taken back, whatever the journals say.
    if (options.fixedLocation && await hasMoveJournal(options.profilePath)) {
      // A fixed location ignores the selection, so the journal cannot tell which side is in use;
      // the next start without a fixed location settles the move.
      workspace.jobStore.event({
        severity: 'warning', eventType: 'vault.move_pending', vaultPath: null, jobId: null,
        message: '有尚未完成的知識庫搬移；這次啟動指定了固定的知識庫位置，搬移留待下次一般啟動時處理。',
      });
    } else {
      await workspace.recoverMove(selected, root);
    }
    await recoverImport(options.profilePath, [selected, root]);
    // An import a stop interrupted after its commit point is finished before anything reads the Vault.
    const finished = await finishInPlaceImports(root);
    workspace.current = await workspace.makeBundle(root, options.searchPort);
    workspace.lastSync = syncSummary(await readSyncHistory(root));
    workspace.previousPaths = await previousLocations(options.profilePath, workspace.current.vaultId);
    if (finished) {
      try { await workspace.current.runtime.search.rebuild(); }
      catch (error) { await workspace.current.runtime.close(); throw error; }
    }
    try {
      // Interrupted jobs continue before the scheduler can submit a check of the same channel.
      await workspace.current.jobs.resume();
      await workspace.current.schedule.start();
    } catch (error) {
      await workspace.current.jobs.close().catch(() => undefined);
      await workspace.current.runtime.close().catch(() => undefined);
      throw error;
    }
    return workspace;
  }

  status(): TransferStatus {
    const problem = this.relocationProblem();
    return {
      ...this.statusValue, vaultPath: this.current.root, lastSync: this.lastSync,
      relocationUnavailable: problem ? { code: problem.code, message: problem.message } : null,
    };
  }

  /** Which activity belongs to the active Vault: its ID, its path, and the locations it was moved from. */
  activityScope(): { vaultPath: string; vaultId: string; previousPaths: string[] } {
    return { vaultPath: this.current.root, vaultId: this.current.vaultId, previousPaths: this.previousPaths };
  }

  /** Why the active Vault can be neither moved nor switched for another one; null when it can. */
  private relocationProblem(): CollectorError | null {
    if (this.options.fixedLocation) {
      return new CollectorError('vault_location_fixed', '這次啟動指定了固定的知識庫位置，無法搬移或開啟其他知識庫。');
    }
    return null;
  }

  assertReadable(): void {
    if (this.mergeWriting) throw new CollectorError('vault_busy', '正在套用匯入的內容，請稍後再讀取。');
  }

  /** Acquired by HTTP writes before any handler can yield. */
  enterWrite(): () => void {
    if (this.locked) {
      const operation = this.statusValue.operation;
      throw new CollectorError('vault_busy', operation === 'move' ? '正在搬移知識庫，請等搬移完成後再操作。'
        : operation === 'open' ? '正在開啟其他知識庫，請等它完成後再操作。' : '正在匯出或匯入知識庫，請等它完成後再操作。');
    }
    this.requests += 1;
    let released = false;
    return () => { if (!released) { released = true; this.requests -= 1; } };
  }

  private get folders() {
    return { vaultRoot: this.current.root, profilePath: this.options.profilePath };
  }

  /**
   * Takes the transfer lock at once, so a second transfer or a write is refused from this moment.
   * Collection stops starting new steps until `end`.
   */
  private lock(operation: TransferOperation): void {
    if (this.locked || this.requests) {
      throw new CollectorError('vault_busy', '正在進行其他知識庫操作，請等它完成後再試。');
    }
    this.locked = true;
    this.current.schedule.setSuspended(true);
    this.statusValue = {
      state: 'waiting', operation, message: '正在等待目前的收集步驟完成…', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
    };
  }

  /** Waits for the collection steps and the subscription check already running; `cancelWait` ends the wait. */
  private async settleCollection(): Promise<void> {
    const abort = new AbortController();
    this.waitAbort = abort;
    try {
      this.releaseJobs = await this.current.jobs.hold(this.holdTimeoutMs, abort.signal);
      await abortable(this.current.schedule.idle(), abort.signal);
    } finally {
      this.waitAbort = null;
    }
  }

  /**
   * Cancels the transfer that is still waiting for collection steps: collection continues, nothing
   * is written, and the status returns to idle. A transfer past the wait runs to its end.
   */
  cancelWait(): TransferStatus {
    if (!this.waitAbort) throw new CollectorError('invalid_request', '目前沒有等待中的知識庫操作；已開始的處理無法取消。');
    this.waitAbort.abort(new CollectorError('transfer_cancelled', '已取消，資料未變更。'));
    this.waitAbort = null;
    this.cancelled();
    return this.status();
  }

  private cancelled(): void {
    this.statusValue = {
      state: 'idle', operation: null, message: '已取消，資料未變更。', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
    };
  }

  private end(): void {
    this.releaseJobs?.();
    this.releaseJobs = null;
    this.locked = false;
    this.current.schedule.setSuspended(false);
  }

  /** Runs one transfer step under the lock; the lock is released whether it succeeds or fails. */
  private async run<T>(operation: TransferOperation, label: string, body: () => Promise<T>): Promise<T> {
    this.lock(operation);
    try {
      await this.settleCollection();
      return await body();
    } catch (error) {
      this.fail(error, label);
      throw error;
    } finally {
      this.end();
    }
  }

  private progress(state: TransferStatus['state'], message: string): void {
    this.statusValue = { ...this.statusValue, state, message };
  }

  /** Where an export goes when no other place is chosen: the export folder and a file name of today. */
  exportSuggestion(): ExportSuggestion {
    const folder = this.options.exportFolder;
    return { folder, path: path.join(folder, exportFileName(new Date())) };
  }

  /**
   * Writes the export of the active Vault to `file`, or to the suggested file in the export folder
   * when `file` is left out; an existing file is replaced only with `overwrite`. The export is a
   * sync point: the Vault records its items under the ID the file carries before the file appears.
   */
  async exportTo(file?: unknown, overwrite = false): Promise<TransferStatus> {
    let requested = file;
    if (requested === undefined || requested === null) {
      await mkdir(this.options.exportFolder, { recursive: true });
      requested = this.exportSuggestion().path;
    }
    const target = await checkExportFile(requested, overwrite, this.folders);
    return this.run('export', '匯出', async () => {
      const root = this.current.root;
      const exportedAt = new Date();
      const history = await readSyncHistory(root);
      const id = randomUUID();
      // Written beside the target and renamed, so the named file is either a whole export or untouched.
      const temporary = `${target}.${randomUUID()}.tmp`;
      let written: WrittenPackage;
      try {
        written = await this.pack(temporary, exportedAt, { id, ancestors: history.points.map((point) => point.id) });
        const items = syncItems(await itemStates(registeredSource(await registeredFiles(root))));
        await writeAtomically(path.join(root, SYNC_FILE),
          syncFileBytes({ id, at: exportedAt.toISOString(), kind: 'export', machine: this.machine, items }, history.points));
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      this.lastSync = { at: exportedAt.toISOString(), kind: 'export', machine: this.machine };
      const result: TransferResult = { exportPath: target, exportBytes: (await stat(target)).size, unregisteredFiles: written.unregisteredFiles };
      const others = result.unregisteredFiles ? `知識庫資料夾中有 ${result.unregisteredFiles} 個不屬於知識庫的檔案沒有包含。` : '';
      this.statusValue = { ...this.statusValue, state: 'completed', message: `已匯出：${target}${others}`, result };
      this.record('info', 'vault.exported', `已匯出知識庫：${target}${others}`);
      return this.status();
    });
  }

  private async pack(file: string, exportedAt: Date, sync: Pick<PackageSync, 'id' | 'ancestors'>): Promise<WrittenPackage> {
    this.progress('exporting', '正在匯出…');
    return writePackage(this.current.root, file, {
      createdBy: this.options.createdBy, exportedAt, sync: { ...sync, vaultId: this.current.vaultId, machine: this.machine },
    });
  }

  /**
   * Makes a prepared Vault the active one. Writing the device selection is the commit point of every
   * switch: before it the previous Vault stays active and untouched, after it the switch is never
   * undone. Returns the previous Vault, whose services `switchTo` then stops.
   */
  private async commit(candidate: Bundle): Promise<Bundle> {
    await this.options.selection.write(candidate.root);
    const previous = this.current;
    // The hold belongs to the previous Vault's jobs, which stop with the switch.
    this.releaseJobs = null;
    this.current = candidate;
    return previous;
  }

  /**
   * Settles a committed switch: stops the previous Vault's scheduler, jobs and search, then continues
   * the unfinished jobs of the Vault now in use and starts its scheduler. The previous jobs are
   * recorded as interrupted with `reason`; after a move (`moved`) they are recorded at the new
   * location first, so they continue there as the same jobs. Each step that fails is logged and the
   * switch still completes, because the selection already names the new Vault.
   */
  private async switchTo(previous: Bundle, how: { reason: string; stop: JobStopKind; moved: boolean }): Promise<{ interruptedJobs: number; resumedJobs: number }> {
    const interruptedJobs = previous.jobs.unfinishedCount();
    if (!how.moved) {
      // The original of an unfinished move is in use again; its removal must never run.
      await step('Releasing the move journal failed', async () => {
        if (await belongsToMove(this.options.profilePath, this.current.root)) await clearMoveJournal(this.options.profilePath);
      });
    }
    await step('Previous schedule shutdown failed', () => previous.schedule.close());
    await step('Previous jobs shutdown failed', () => previous.jobs.close(how.reason, how.stop));
    if (how.moved && this.current.vaultId) {
      const vaultId = this.current.vaultId;
      await step('Moving jobs to the new location failed', async () => {
        this.jobStore.rebind(previous.root, this.current.root, vaultId);
        await this.jobStore.flush();
      });
    }
    await step('Previous search shutdown failed', () => previous.runtime.close());
    await step('Resuming jobs failed', () => this.current.jobs.resume());
    await step('Schedule start failed', () => this.current.schedule.start());
    this.lastSync = syncSummary(await readSyncHistory(this.current.root));
    this.previousPaths = await previousLocations(this.options.profilePath, this.current.vaultId);
    return { interruptedJobs, resumedJobs: this.current.jobs.unfinishedCount() };
  }

  /** Checks a move of the active Vault to `target` without starting it. */
  async checkMove(target: unknown): Promise<MoveCheck> {
    const problem = this.relocationProblem();
    if (problem) throw problem;
    if (this.locked) throw new CollectorError('vault_busy', '正在進行其他知識庫操作，請等它完成後再試。');
    try {
      const checked = await checkMoveTarget(target, this.folders, await this.vaultBytes(), { free: this.options.statfs });
      return { targetPath: checked.target, requiredBytes: checked.requiredBytes, availableBytes: checked.availableBytes };
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      console.error('Checking a move location failed', error);
      throw new CollectorError('invalid_request', '無法檢查新位置或目前的知識庫，請確認位置存在且有權限讀取後重試。');
    }
  }

  /** Size of the active Vault; the move itself scans again, so a briefly reused size only guides the check. */
  private async vaultBytes(): Promise<number> {
    const root = this.current.root;
    const now = Date.now();
    if (this.sizeCache?.root === root && now - this.sizeCache.at < SIZE_REUSE_MS) return this.sizeCache.bytes;
    const bytes = treeBytes(await scanVault(root));
    this.sizeCache = { root, bytes, at: now };
    return bytes;
  }

  /**
   * Moves the active Vault to `target` and continues its work there; progress is in `status`. The
   * location is checked before anything stops, so a refused location leaves collection running.
   */
  async move(target: unknown): Promise<TransferStatus> {
    const checked = await this.checkMove(target);
    this.lock('move');
    this.dropPreview();
    this.operation = this.moveOnce(checked.targetPath).finally(() => { this.operation = null; });
    return this.status();
  }

  private async fault(phase: MoveFault, count?: number): Promise<void> {
    await this.options.moveFaults?.(phase, count);
  }

  private async moveOnce(target: string): Promise<void> {
    const profile = this.options.profilePath;
    const source = this.current.root;
    const vaultId = this.current.vaultId!;
    let journal: MoveJournal | null = null;
    let placed = false;
    let candidate: Bundle | null = null;
    let previous: Bundle | null = null;
    try {
      await this.settleCollection();
      this.record('info', 'vault.move_started', `開始把知識庫從 ${source} 搬移到 ${target}。`);
      this.progress('validating', '正在檢查新位置…');
      const entries = await scanVault(source);
      await checkMoveTarget(target, this.folders, treeBytes(entries), { free: this.options.statfs });
      journal = {
        version: 1, vaultId, source, target, staging: movingFolder(target), phase: 'copying', marker: null, emptyTarget: false, removal: null,
      };
      await writeMoveJournal(profile, journal);
      await mkdir(journal.staging, { mode: 0o700 });
      this.statusValue = { ...this.statusValue, state: 'copying', message: '正在複製檔案…', completedFiles: 0, totalFiles: entries.length };
      await copyTree(source, journal.staging, entries, async (done) => {
        this.statusValue = { ...this.statusValue, completedFiles: done };
        await this.fault('copying', done);
      });
      await this.fault('copied');
      this.progress('verifying', '正在檢查複製結果…');
      await verifyTree(source, journal.staging, entries);
      await this.fault('verified');
      // The location may have changed while copying; space is already taken by the copy itself.
      await checkMoveTarget(target, this.folders, 0, { free: unlimitedSpace });
      journal = { ...journal, phase: 'placed', marker: await markerDigest(journal.staging), emptyTarget: await exists(target) };
      await writeMoveJournal(profile, journal);
      if (journal.emptyTarget) await rm(target, { recursive: true });
      await rename(journal.staging, target);
      placed = true;
      await this.fault('placed');
      this.progress('indexing', '正在新位置建立搜尋索引…');
      candidate = await this.makeBundle(target);
      if (candidate.vaultId !== vaultId) throw new Error('The moved Vault does not carry the ID of the original');
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
      await this.fault('prepared');
      await this.fault('committing');
      previous = await this.commit(candidate);
      candidate = null;
      placed = false;
    } catch (error) {
      this.moveFailed(error, source);
    }
    if (!previous) {
      try {
        if (candidate) {
          await candidate.schedule.close();
          await candidate.jobs.close();
          await candidate.runtime.close();
        }
        // A move that fails before the switch takes its copy back, leaving the new location as it was.
        if (placed && journal) await rename(target, journal.staging);
        if (journal?.emptyTarget && !await exists(target)) await mkdir(target);
        if (journal) {
          await rm(journal.staging, { recursive: true, force: true });
          await this.removeSearchData(target);
          await clearMoveJournal(profile);
        }
      } catch (error) {
        console.error('Move cleanup failed', error);
      }
      this.end();
      return;
    }
    try {
      await this.finishMove(previous, journal!);
    } finally {
      this.end();
    }
  }

  /** Continues the moved Vault's work at its new location, then removes the original location. */
  private async finishMove(previous: Bundle, placedJournal: MoveJournal): Promise<void> {
    const profile = this.options.profilePath;
    const { source, target, vaultId } = placedJournal;
    let journal: MoveJournal = { ...placedJournal, phase: 'switched' };
    await step('Move fault', () => this.fault('selected'));
    await step('Move journal update failed', () => writeMoveJournal(profile, journal));
    await step('Move fault', () => this.fault('committed'));
    const { resumedJobs } = await this.switchTo(previous, {
      reason: '搬移知識庫時暫停；搬移完成後在新位置接續。', stop: 'vault_move', moved: true,
    });
    await this.settleRelocation(vaultId, source, target);
    this.previousPaths = await previousLocations(profile, this.current.vaultId);
    this.progress('cleaning', '正在清除原位置…');
    let leftover: string | null = source;
    try {
      const removal = await removeOriginal(profile, journal, () => this.fault('cleaning'));
      journal = removal.journal;
      leftover = removal.leftover;
    } catch (error) {
      console.error('Removing the original location failed', error);
    }
    const jobs = resumedJobs ? `${resumedJobs} 個收集工作已接續。` : '';
    const message = leftover
      ? `已搬移到 ${target} 並開始使用，但原位置未能清除：${leftover}。請確認後手動刪除這個資料夾。${jobs}`
      : `已搬移到 ${target} 並開始使用，原位置已清除。${jobs}`;
    this.statusValue = {
      ...this.statusValue, state: 'completed', errorCode: null, message,
      result: { previousVaultPath: source, resumedJobs, ...(leftover ? { leftoverPath: leftover } : {}) },
    };
    this.record('info', 'vault.moved', `已把知識庫從 ${source} 搬移到 ${target}。${jobs}`);
    if (leftover) {
      this.record('warning', 'vault.move_cleanup_failed', `原位置未能清除：${leftover}。請確認後手動刪除這個資料夾。`);
    }
  }

  /**
   * Device records that follow a committed move, in the running app and in recovery at startup: the
   * previous location joins the Vault's history and the search database of the previous path is
   * removed. Each step that fails is logged. The sync points live in the Vault and move with it.
   */
  private async settleRelocation(vaultId: string, source: string, target: string): Promise<void> {
    const profile = this.options.profilePath;
    await step('Recording the previous location failed', () => recordPreviousLocation(profile, vaultId, source, target));
    await step('Previous search database removal failed', () => this.removeSearchData(source));
  }

  private moveFailed(error: unknown, source: string): void {
    if (error instanceof CollectorError && error.code === 'transfer_cancelled') {
      this.fail(error, '搬移');
      return;
    }
    const reason = error instanceof CollectorError ? error.message : '無法完成複製或準備新位置，請確認磁碟空間、權限與搜尋服務後重試。';
    const message = `搬移失敗：${reason}知識庫仍在原位置 ${source}，資料未變更，收集已恢復。`;
    this.statusValue = {
      ...this.statusValue, state: 'error', result: null, message,
      errorCode: error instanceof CollectorError ? error.code : null,
    };
    if (!(error instanceof CollectorError)) console.error('Move failed', error);
    this.record('error', 'vault.move_failed', message, undefined, error instanceof CollectorError ? error.code : undefined);
  }

  /**
   * Switches to another existing Vault; progress is in `status`. The active Vault stays where it is,
   * and its unfinished jobs continue when it is opened again.
   */
  async openOther(value: unknown): Promise<TransferStatus> {
    const problem = this.relocationProblem();
    if (problem) throw problem;
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
      throw new CollectorError('invalid_request', '請提供知識庫資料夾的完整路徑。');
    }
    const root = path.resolve(value);
    if (isWorkFolder(root)) {
      throw new CollectorError('invalid_request', '這是搬移或匯入使用的暫存資料夾，不能當作知識庫開啟。請開啟搬移後的新位置。');
    }
    if (await isWithin(root, this.current.root)) {
      throw new CollectorError('invalid_request', await isWithin(this.current.root, root)
        ? '這就是目前使用中的知識庫。' : '不能開啟目前知識庫裡的資料夾。');
    }
    if (await isWithin(root, this.options.profilePath)) throw new CollectorError('invalid_request', '不能開啟程式資料目錄裡的資料夾。');
    const inspection = await inspectVaultDirectory(root);
    if (inspection.kind === 'empty') throw new CollectorError('vault_invalid', '這個資料夾還不是知識庫，請選擇已有的知識庫。');
    if (inspection.kind === 'invalid') throw new CollectorError('vault_invalid', inspection.reason);
    this.lock('open');
    this.dropPreview();
    this.operation = this.openOnce(inspection.path).finally(() => { this.operation = null; });
    return this.status();
  }

  private async openOnce(root: string): Promise<void> {
    let candidate: Bundle | null = null;
    let previous: Bundle | null = null;
    try {
      await this.settleCollection();
      this.progress('indexing', '正在開啟知識庫並建立搜尋索引…');
      candidate = await this.makeBundle(root);
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
      previous = await this.commit(candidate);
      candidate = null;
    } catch (error) {
      if (!(error instanceof CollectorError)) console.error('Opening another Vault failed', error);
      this.fail(error instanceof CollectorError ? error
        : new CollectorError('vault_invalid', `無法開啟 ${root}，請確認資料夾與搜尋服務後重試。目前的知識庫不變。`), '開啟其他知識庫');
    }
    try {
      if (candidate) {
        await step('Candidate schedule shutdown failed', () => candidate!.schedule.close());
        await step('Candidate jobs shutdown failed', () => candidate!.jobs.close());
        await step('Candidate search shutdown failed', () => candidate!.runtime.close());
      }
      if (!previous) return;
      const { interruptedJobs, resumedJobs } = await this.switchTo(previous, {
        reason: '切換到其他知識庫時工作尚未完成；回到這個知識庫時接續。', stop: 'vault_switch', moved: false,
      });
      const paused = interruptedJobs ? `它的 ${interruptedJobs} 個收集工作已暫停，回到原知識庫時接續。` : '';
      const resumed = resumedJobs ? `這個知識庫有 ${resumedJobs} 個收集工作接續。` : '';
      const message = `已開啟知識庫 ${root}。原知識庫保留在 ${previous.root}。${paused}${resumed}`;
      this.statusValue = {
        ...this.statusValue, state: 'completed', errorCode: null, message,
        result: { previousVaultPath: previous.root, interruptedJobs, resumedJobs },
      };
      // Device-level, so both Vaults show the switch.
      this.record('info', 'vault.opened', message, null);
    } finally {
      this.end();
    }
  }

  /** Takes a move interrupted by a stop forward or back before the Vault opens; see `recoverMove`. */
  private async recoverMove(selected: string | null, root: string): Promise<void> {
    const recovery = await recoverMove(this.options.profilePath, {
      selected, kept: [selected, root], jobStore: this.jobStore, removeSearch: (folder) => this.removeSearchData(folder),
    });
    if (!recovery || recovery.released) return;
    const base = { vaultPath: recovery.committed ? recovery.target : recovery.source, vaultId: recovery.vaultId, jobId: null };
    if (!recovery.committed) {
      this.jobStore.event({ ...base, severity: 'warning', eventType: 'vault.move_failed',
        message: `搬移在完成前中斷；知識庫仍在原位置 ${recovery.source}，資料未變更。` });
      return;
    }
    await this.settleRelocation(recovery.vaultId, recovery.source, recovery.target);
    this.jobStore.event({ ...base, severity: 'info', eventType: 'vault.moved',
      message: `已完成上次中斷的搬移：知識庫在 ${recovery.target}。` });
    if (recovery.leftover) {
      this.jobStore.event({ ...base, severity: 'warning', eventType: 'vault.move_cleanup_failed',
        message: `原位置未能清除：${recovery.leftover}。請確認後手動刪除這個資料夾。` });
    }
  }

  /**
   * Compares an export file with the active Vault and keeps the comparison for `applyImport`. The
   * file stays where it is; the comparison is dropped when another Vault operation starts.
   */
  async previewImport(file: unknown): Promise<ImportPreview> {
    const source = await checkPackageFile(file);
    return this.run('import', '匯入', async () => {
      // A comparison refused for a busy Vault leaves the previous one usable.
      this.dropPreview();
      this.progress('validating', '正在檢查匯出檔…');
      const reader = await openPackage(source);
      try {
        await checkPackageContent(reader);
        this.progress('validating', '正在比對…');
        const { comparison, baseline } = await this.compare(reader);
        const { exportedAt, sync } = reader.manifest;
        const value: ImportPreview = {
          id: randomUUID(), situation: comparison.situation,
          package: { fileName: path.basename(source), exportedAt: exportedAt ?? null, machine: sync?.machine ?? null },
          incoming: comparison.incoming, conflicts: comparison.conflicts, replaceLoses: comparison.replaceLoses,
        };
        this.preview = { value, comparison, baseline, file: source, identity: reader.identity };
        this.statusValue = { ...this.statusValue, state: 'completed', message: '比對完成。' };
        return value;
      } finally {
        reader.close();
      }
    });
  }

  /**
   * Compares the local items, the newest sync point the file and the Vault share, and the file's
   * items. The baseline digest covers what an apply stands on: the local items, the shared point
   * and the file. Collection progress and check times are no items, so a check the scheduler runs
   * after a preview leaves the baseline as it was.
   */
  private async compare(reader: PackageReader): Promise<{
    comparison: Comparison; baseline: string; history: SyncHistory; local: ItemStates; incoming: ItemStates;
  }> {
    const root = this.current.root;
    const history = await readSyncHistory(root);
    if (history.problem) this.record('warning', 'vault.sync_unreadable', `${history.problem}這次匯入視為兩邊沒有共同同步點。`);
    const local = await itemStates(registeredSource(await registeredFiles(root)));
    const incoming = await itemStates(reader);
    const sync = reader.manifest.sync;
    const base = sharedPoint(history, sync ? [sync.id, ...sync.ancestors] : []);
    const comparison = compareItems(local, base?.items ?? null, incoming, { local: this.machine, incoming: sync?.machine ?? null });
    const baseline = createHash('sha256').update(canonicalJson([[...syncItems(local)], base?.id ?? null, reader.identity])).digest('hex');
    return { comparison, baseline, history, local, incoming };
  }

  /** Forgets the comparison waiting to be applied. */
  private dropPreview(): void {
    this.preview = null;
  }

  cancelImport(id: string): void {
    if (this.locked) throw new CollectorError('vault_busy', '正在套用匯入，請等待結果。');
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    this.dropPreview();
    this.statusValue = { ...this.statusValue, state: 'idle', operation: null, message: '已取消匯入，資料未變更。', result: null };
  }

  /**
   * Applies a compared import in place: a merge takes the file's own changes and the conflicts
   * chosen for it, a replace makes every item what the file holds. Progress is in `status`.
   */
  applyImport(id: string, mode: unknown, choices?: Record<string, ImportChoice>): TransferStatus {
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    if (mode !== 'merge' && mode !== 'replace') throw new CollectorError('invalid_request', 'mode 必須是 merge 或 replace。');
    if (choices !== undefined && (!choices || typeof choices !== 'object' || Array.isArray(choices))) {
      throw new CollectorError('invalid_request', '衝突選擇格式無效。');
    }
    const preview = this.preview;
    if (mode === 'merge' && preview.value.situation === 'nothing') throw new CollectorError('invalid_request', '沒有需要匯入的內容。');
    if (mode === 'replace' && !preview.comparison.differing.length) throw new CollectorError('invalid_request', '本機內容已與匯入檔相同。');
    chosenKeys(preview.comparison, mode, choices);
    this.lock('import');
    this.operation = this.importOnce(preview, mode, choices).catch((error: unknown) => this.fail(error, '匯入')).finally(() => { this.operation = null; });
    return this.status();
  }

  /**
   * Exports the Vault as it is into the export folder before an import changes it, so a wrong
   * import can be undone by importing this file. It records no sync point; its manifest names the
   * Vault's sync points as its ancestors.
   */
  private async preImportExport(history: SyncHistory): Promise<string> {
    const folder = this.options.exportFolder;
    await mkdir(folder, { recursive: true });
    const now = new Date();
    const name = preImportFileName(now);
    let target = path.join(folder, name);
    for (let index = 2; await exists(target); index += 1) target = path.join(folder, name.replace(/\.zip$/u, ` (${index}).zip`));
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await this.pack(temporary, now, { id: null, ancestors: history.points.map((point) => point.id) });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return target;
  }

  private async importOnce(preview: Preview, mode: ImportMode, choices: Record<string, ImportChoice> | undefined): Promise<void> {
    const root = this.current.root;
    let reader: PackageReader | null = null;
    let safeToResume = true;
    let applying = false;
    try {
      await this.settleCollection();
      this.progress('validating', '正在檢查本機資料…');
      reader = await openPackage(preview.file);
      const current = reader.identity === preview.identity ? await this.compare(reader) : null;
      if (!current || current.baseline !== preview.baseline) {
        this.dropPreview();
        throw new CollectorError('invalid_request', '本機資料或匯入檔在比對後有變更，請重新選擇匯入檔。');
      }
      const keys = chosenKeys(current.comparison, mode, choices);
      const changes = await planChanges(registeredSource(await registeredFiles(root)), reader, keys);
      const counts: ImportCounts = { added: 0, modified: 0, removed: 0 };
      for (const key of keys) {
        const before = current.local.get(key)?.state === 'present';
        const after = current.incoming.get(key)?.state === 'present';
        if (before && after) counts.modified += 1; else if (after) counts.added += 1; else counts.removed += 1;
      }
      this.progress('exporting', '正在匯出目前的內容…');
      const backup = await this.preImportExport(current.history);
      const incomingBytes = [...changes.values()].reduce((sum, change) => sum + (!change ? 0
        : 'bytes' in change ? change.bytes.length : reader!.manifest.files.find((row) => row.path === change.incoming)?.size ?? 0), 0);
      await checkFreeSpace(root, incomingBytes, this.options.statfs);
      const point = importedPoint(reader, current.incoming, new Date());
      this.mergeWriting = true;
      applying = true;
      this.statusValue = { ...this.statusValue, state: 'extracting', message: '正在套用匯入的內容…', completedFiles: 0, totalFiles: changes.size + 1 };
      await applyInPlace(root, reader, changes, syncFileBytes(point, current.history.points), (done, total) => {
        this.statusValue = { ...this.statusValue, completedFiles: done, totalFiles: total };
      }, this.options.importFaults);
      applying = false;
      this.progress('indexing', '正在更新搜尋索引…');
      if (mode === 'replace') await this.current.runtime.search.rebuild();
      else await this.indexChanged(changes);
      await this.reloadSchedule();
      this.mergeWriting = false;
      this.dropPreview();
      this.lastSync = { at: point.at, kind: 'import', machine: point.machine };
      const summary = `新增 ${counts.added}、修改 ${counts.modified}、刪除 ${counts.removed}`;
      const how = mode === 'replace' ? '已完全以匯入內容取代' : '匯入完成';
      this.statusValue = {
        ...this.statusValue, state: 'completed', message: `${how}：${summary}。匯入前的內容已匯出到 ${backup}`,
        result: { importMode: mode, imported: counts, writtenFiles: changes.size, preImportExportPath: backup },
      };
      this.record('info', 'vault.imported', `${how}（${preview.value.package.fileName}）：${summary}。匯入前的內容已匯出到 ${backup}`);
    } catch (error) {
      if (applying) {
        // Past the journal, the import is carried out to its end; before it, the Vault was never touched.
        try {
          if (await finishInPlaceImports(root)) {
            await this.current.runtime.search.rebuild();
            await this.reloadSchedule();
          }
        } catch {
          safeToResume = false;
          throw new CollectorError('vault_busy', '匯入未完成，已停止寫入與排程。請重新啟動程式以完成匯入。');
        }
      }
      throw error;
    } finally {
      reader?.close();
      if (safeToResume) { this.mergeWriting = false; this.end(); }
    }
  }

  /** Brings the search index up to date with the documents an import wrote or removed. */
  private async indexChanged(changes: ReadonlyMap<string, unknown>): Promise<void> {
    const vault = new MarkdownVault(this.current.root);
    for (const relative of changes.keys()) {
      const id = documentIdFromPath(relative);
      if (!id) continue;
      const document = await vault.read(id).catch(() => null);
      if (document) await this.current.runtime.search.index(document);
      else await this.current.runtime.search.remove(id);
    }
  }

  private async reloadSchedule(): Promise<void> {
    await this.current.schedule.close();
    this.current.schedule = makeScheduler(this.current);
    this.current.schedule.setSuspended(true);
    await this.current.schedule.start();
  }

  private fail(error: unknown, operation: string): void {
    if (error instanceof CollectorError && error.code === 'transfer_cancelled') {
      this.cancelled();
      this.record('info', 'vault.transfer_cancelled', `已取消${operation}，資料未變更。`);
      return;
    }
    this.statusValue = {
      ...this.statusValue, state: 'error', result: null,
      errorCode: error instanceof CollectorError ? error.code : null,
      message: error instanceof CollectorError ? error.message : '操作失敗，請確認匯出檔、磁碟空間與搜尋服務後重試。',
    };
    this.record('error', 'vault.transfer_failed', `${operation}失敗：${this.statusValue.message}`,
      undefined, error instanceof CollectorError ? error.code : undefined);
  }

  /** Records a Vault operation in the device activity log, under the active Vault unless `vaultPath` says otherwise. */
  private record(severity: 'info' | 'warning' | 'error', eventType: string, message: string, vaultPath?: string | null, errorCode?: string): void {
    const own = vaultPath === undefined;
    this.jobStore.event({
      severity, eventType, message, vaultPath: own ? this.current.root : vaultPath, jobId: null,
      ...(own && this.current.vaultId ? { vaultId: this.current.vaultId } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  /** Each Vault path gets its own rebuildable search database on this device. */
  private searchPath(root: string): string {
    return `${this.options.searchData}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  }

  /** Removes the search database of a Vault path and its state record; used when the path stops being a Vault. */
  private async removeSearchData(root: string): Promise<void> {
    if (this.options.createSearch) return;
    const database = this.searchPath(root);
    await rm(database, { recursive: true, force: true });
    await rm(`${database}-state.json`, { force: true });
  }

  private async makeBundle(root: string, port?: number): Promise<Bundle> {
    const vaultId = await readVaultId(root);
    if (!vaultId) throw new CollectorError('vault_invalid', '知識庫標記檔沒有識別碼，不是目前支援的知識庫格式，無法開啟。');
    const vault = new MarkdownVault(root);
    // Deletions a stop left unfinished are settled before the search index is compared with the Vault.
    const recovery = await vault.recoverDeletions();
    const runtime = this.options.createSearch ? await this.options.createSearch(root) : await startSearchRuntime({
      vault, binaryPath: this.options.searchBinary, databasePath: this.searchPath(root),
      ...(port ? { port } : {}),
    });
    const collector = new Collector(vault, runtime.search, { recordEvent: (entry) => jobs.recordEvent(entry) });
    const channelStore = new JsonChannelStore(root);
    const source = youtubeSource(this.options.capture, this.options.channelSource);
    // The scheduler is replaced after a merge, so switch reads go through the bundle.
    const autoCollection = () => bundle.schedule.isEnabled();
    // Jobs hold this bundle's own Vault objects, so they never write through to a Vault switched in later.
    const jobs = new JobManager({
      vaultPath: root,
      vaultId,
      store: this.jobStore,
      source,
      documents: collector,
      channels: channelStore,
      checkChannel: async (channelId) => (await bundle.channels.startRun({ trigger: 'manual', channelIds: [channelId] }))[0]!,
      ...(this.options.jobLimits ? { limits: this.options.jobLimits } : {}),
      ...(this.options.jobRetry ? { retry: this.options.jobRetry } : {}),
      ...(this.options.pacing ? { pacing: this.options.pacing } : {}),
    });
    const channels = new ChannelCollector(channelStore, jobs, {
      autoCollection, resolveChannel: (url, signal) => source.resolveChannel(url, { priority: 'interactive', signal }), documents: () => collector.list(),
    });
    for (const record of recovery.completed) {
      jobs.recordEvent({
        severity: 'info', eventType: 'document.delete_resumed', message: `已完成上次未完成的刪除：「${record.title}」。`,
        documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title,
      });
    }
    for (const record of recovery.unresolved) {
      jobs.recordEvent({
        severity: 'warning', eventType: 'document.delete_unresolved',
        message: `「${record.title}」有刪除紀錄，但文件檔缺少可讀的收集時間；文件維持隱藏，檔案與刪除紀錄都保留。`,
        documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title,
      });
    }
    for (const record of recovery.cleared) {
      jobs.recordEvent({
        severity: 'info', eventType: 'document.recollected', message: `已重新收集「${record.title}」，解除刪除紀錄。`,
        documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title,
      });
    }
    const partial = { root, vaultId, runtime, collector, channels, jobs };
    const bundle: Bundle = { ...partial, schedule: makeScheduler(partial) };
    return bundle;
  }

  async close(): Promise<void> {
    await this.operation;
    this.dropPreview();
    const drained = await Promise.allSettled([
      this.current.schedule.close(),
      this.current.jobs.close(),
    ]);
    const search = await Promise.allSettled([this.current.runtime.close()]);
    const failed = [...drained, ...search].find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Runs one step of a switch that has already happened; a failure is logged and the switch goes on. */
async function step(label: string, work: () => Promise<unknown>): Promise<void> {
  try { await work(); } catch (error) { console.error(label, error); }
}

/** Free space that never runs out, for a check that has already reserved its space. */
const unlimitedSpace: StatFs = async () => ({ bavail: Number.MAX_SAFE_INTEGER, bsize: 1 });

function makeScheduler(bundle: Pick<Bundle, 'root' | 'channels' | 'jobs'>): ChannelScheduler {
  return new ChannelScheduler(bundle.channels, new JsonChannelScheduleStore(bundle.root), {
    recordEvent: (entry) => bundle.jobs.recordEvent(entry),
  });
}

/** Settles with `work`, or rejects with the signal's reason once it is aborted. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

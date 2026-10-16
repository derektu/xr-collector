import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Collector } from '../core/collector.js';
import {
  CollectorError, type JobStopKind, type MergePreview, type MergeChoice, type MoveCheck, type TransferOperation, type TransferResult,
  type TransferStatus, type TranscriptSearch,
} from '../core/types.js';
import { ChannelCollector } from '../channels/channel-collector.js';
import { ChannelScheduler } from '../channels/channel-scheduler.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../channels/json-channel-schedule-store.js';
import { migrateSubscriptionSettings, readLegacySettings } from '../channels/subscription-files.js';
import { JobManager, type JobLimits, type RetryPolicy } from '../jobs/job-manager.js';
import { JobStore } from '../jobs/job-store.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { youtubeSource, type YouTubeCapture, type YouTubeChannelSource } from '../sources/youtube/adapter.js';
import { MarkdownVault } from './markdown-vault.js';
import { deletionId } from './deleted-documents.js';
import { compareFiles, mergeBaseline, packageFiles, mergeFiles } from './vault-merge.js';
import { exportVault, packageInfo, unpackVault, safePath } from './vault-package.js';
import { documentIdFromPath } from './document-paths.js';
import {
  checkExportFile, checkRestoreFolder, clearRestoreJournal, isWithin, isWorkFolder, markerDigest, readLastExport, readPackageFile, recordExport, recoverRestore,
  stagingFolder, suggestRestoreFolder, writePackageFile, writeRestoreJournal, type RestoreJournal,
} from './transfer-files.js';
import { ensureVaultId, inspectVaultDirectory, writeVaultMarker } from './vault-directory.js';
import {
  belongsToMove, checkMoveTarget, clearMoveJournal, copyTree, hasMoveJournal, movingFolder, previousLocations, recordPreviousLocation, recoverMove,
  removeOriginal, scanVault, treeBytes, verifyTree, writeMoveJournal, type MoveJournal, type StatFs,
} from './vault-move.js';
import type { VaultSelection } from './vault-selection.js';

interface Bundle {
  root: string;
  /** ID from the Vault's marker; null when the marker has none and could not be given one. */
  vaultId: string | null;
  collector: Collector;
  channels: ChannelCollector;
  jobs: JobManager;
  schedule: ChannelScheduler;
  runtime: SearchRuntime;
}
export interface WorkspaceOptions {
  /** Absolute path of a Vault that the caller has already inspected. */
  root: string;
  /** Device record of the active Vault; writing it is the commit point of a restore, move or switch. */
  selection: VaultSelection;
  /**
   * Device profile folder: export times, the journals of a restore or move in progress, and the
   * locations each Vault was moved from live here.
   */
  profilePath: string;
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
}

/**
 * Steps of a move a test can stop at. `selected` comes right after the device selection names the
 * new location and before the journal records the switch.
 */
export type MoveFault = 'copying' | 'copied' | 'verified' | 'placed' | 'prepared' | 'committing' | 'selected' | 'committed' | 'cleaning';

/** How long `checkMove` reuses the size of the active Vault while a person types a location. */
const SIZE_REUSE_MS = 60_000;

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
  private preview: { value: MergePreview; baseline: string; incoming: Buffer } | null = null;
  private locked = false;
  private mergeWriting = false;
  private requests = 0;
  private operation: Promise<void> | null = null;
  /** Lifts the collection hold of the running transfer. */
  private releaseJobs: (() => void) | null = null;
  /** Cancels the running transfer while it waits for collection; null once it has started its work. */
  private waitAbort: AbortController | null = null;
  private lastExportedAt: string | null = null;
  private statusValue: Omit<TransferStatus, 'vaultPath' | 'lastExportedAt' | 'relocationUnavailable'> = {
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
  }

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
    await recoverRestore(options.profilePath, [selected, root]);
    const recovered = await workspace.recoverMerge(root);
    workspace.current = await workspace.makeBundle(root, options.searchPort);
    workspace.lastExportedAt = await readLastExport(options.profilePath, root);
    workspace.previousPaths = await previousLocations(options.profilePath, workspace.current.vaultId);
    if (recovered) {
      try { await workspace.current.runtime.search.rebuild(); await rm(`${root}.merge-journal.json`); }
      catch (error) { await workspace.current.runtime.close(); throw error; }
    }
    try {
      // Interrupted jobs continue before the scheduler can submit a check of the same channel.
      await workspace.current.jobs.resume();
      workspace.current.channels.followResumedBacklogs();
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
      ...this.statusValue, vaultPath: this.current.root, lastExportedAt: this.lastExportedAt,
      relocationUnavailable: problem ? { code: problem.code, message: problem.message } : null,
    };
  }

  /** Which activity belongs to the active Vault: its ID, its path, and the locations it was moved from. */
  activityScope(): { vaultPath: string; vaultId: string | null; previousPaths: string[] } {
    return { vaultPath: this.current.root, vaultId: this.current.vaultId, previousPaths: this.previousPaths };
  }

  /** Why the active Vault can be neither moved nor switched for another one; null when it can. */
  private relocationProblem(): CollectorError | null {
    if (this.options.fixedLocation) {
      return new CollectorError('vault_location_fixed', '這次啟動指定了固定的知識庫位置，無法搬移或開啟其他知識庫。');
    }
    if (!this.current.vaultId) {
      return new CollectorError('vault_unidentified',
        '無法在知識庫標記檔寫入識別碼，暫時無法搬移或開啟其他知識庫。請確認知識庫資料夾可以寫入，再重新啟動 XR Collector。');
    }
    return null;
  }

  assertReadable(): void {
    if (this.mergeWriting) throw new CollectorError('vault_busy', '正在合併或復原資料，請稍後再讀取。');
  }

  /** Acquired by HTTP writes before any handler can yield. */
  enterWrite(): () => void {
    if (this.locked) {
      const operation = this.statusValue.operation;
      throw new CollectorError('vault_busy', operation === 'move' ? '正在搬移知識庫，請等搬移完成後再操作。'
        : operation === 'open' ? '正在開啟其他知識庫，請等它完成後再操作。' : '正在備份、還原或合併知識庫，請等它完成後再操作。');
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

  /** The package of the active Vault, as bytes. */
  async export(): Promise<Buffer> {
    return this.run('export', '匯出', async () => {
      const exportedAt = new Date();
      const buffer = await this.pack(exportedAt);
      await this.exported(exportedAt, { exportBytes: buffer.length });
      return buffer;
    });
  }

  /** Writes the package of the active Vault to a file; an existing file is replaced only with `overwrite`. */
  async exportTo(file: unknown, overwrite = false): Promise<TransferStatus> {
    const target = await checkExportFile(file, overwrite, this.folders);
    return this.run('export', '匯出', async () => {
      const exportedAt = new Date();
      const buffer = await this.pack(exportedAt);
      this.progress('exporting', '正在寫入備份檔案…');
      await writePackageFile(target, buffer);
      await this.exported(exportedAt, { exportPath: target, exportBytes: buffer.length });
      return this.status();
    });
  }

  private async pack(exportedAt: Date): Promise<Buffer> {
    this.progress('exporting', '正在建立備份…');
    return exportVault(this.current.root, { createdBy: this.options.createdBy, exportedAt });
  }

  private async exported(at: Date, result: TransferResult): Promise<void> {
    const time = at.toISOString();
    try {
      await recordExport(this.options.profilePath, this.current.root, time);
    } catch (error) {
      // The package is complete either way; only the remembered time is lost.
      console.error('Unable to record the export time', error);
    }
    this.lastExportedAt = time;
    const where = result.exportPath ? `：${result.exportPath}` : '。';
    this.statusValue = { ...this.statusValue, state: 'completed', message: `備份已建立${where}`, result };
    this.record('info', 'vault.exported', `已匯出知識庫備份${where}`);
  }

  /** A free folder beside the active Vault for a restore. */
  suggestRestoreFolder(): Promise<string> {
    return suggestRestoreFolder(this.current.root, new Date());
  }

  /** Restores a package file into a new Vault and switches to it; progress is in `status`. */
  async restoreFrom(packageFile: unknown, folder: unknown): Promise<TransferStatus> {
    const buffer = await readPackageFile(packageFile);
    return this.restore(buffer, folder ?? undefined);
  }

  /**
   * Restores a package into a new Vault in `folder` (a free folder beside the active Vault when
   * omitted) and switches to it once it is complete. The active Vault stays where it is; its
   * unfinished collection jobs stop with the switch and continue when it is opened again.
   */
  async restore(buffer: Buffer, folder?: unknown): Promise<TransferStatus> {
    this.lock('restore');
    let target: string;
    try {
      target = await checkRestoreFolder(folder ?? await this.suggestRestoreFolder(), this.folders);
    } catch (error) {
      this.fail(error, '還原');
      this.end();
      throw error;
    }
    this.preview = null;
    this.operation = this.restoreOnce(buffer, target).finally(() => { this.operation = null; });
    return this.status();
  }

  private async restoreOnce(buffer: Buffer, target: string): Promise<void> {
    const profile = this.options.profilePath;
    let journal: RestoreJournal | null = null;
    let placed = false;
    let candidate: Bundle | null = null;
    let previous: Bundle | null = null;
    try {
      await this.settleCollection();
      this.progress('validating', '正在檢查備份…');
      journal = { staging: stagingFolder(target), target, placed: false, marker: null, emptyTarget: false };
      await writeRestoreJournal(profile, journal);
      await mkdir(journal.staging, { mode: 0o700 });
      await unpackVault(buffer, journal.staging, (done, total) => {
        this.statusValue = { ...this.statusValue, state: 'extracting', message: '正在還原檔案…', completedFiles: done, totalFiles: total };
      });
      await writeVaultMarker(journal.staging, this.options.createdBy);
      // The chosen folder holds at most entries a file manager adds by itself; the staging folder takes its place.
      await checkRestoreFolder(target, this.folders);
      // Recorded before the rename, so a stop at any point after it can take the restored folder back.
      journal = { ...journal, placed: true, marker: await markerDigest(journal.staging), emptyTarget: await pathExists(target) };
      await writeRestoreJournal(profile, journal);
      if (journal.emptyTarget) await rm(target, { recursive: true });
      await rename(journal.staging, target);
      placed = true;
      this.progress('indexing', '正在建立新知識庫的搜尋索引…');
      candidate = await this.makeBundle(target);
      // The candidate owns a separate search database; failed preparation leaves the active vault intact.
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
      previous = await this.commit(candidate);
      placed = false;
      candidate = null;
    } catch (error) {
      this.fail(error, '還原');
    }
    try {
      if (candidate) {
        await candidate.schedule.close();
        await candidate.jobs.close();
        await candidate.runtime.close();
      }
      // A restore that fails after placing its folder takes it back, leaving the chosen folder as it was.
      if (placed && journal) {
        await rename(target, journal.staging);
        await this.removeSearchData(target);
      }
      if (journal?.emptyTarget && !await pathExists(target)) await mkdir(target);
      if (journal) {
        await rm(journal.staging, { recursive: true, force: true });
        await clearRestoreJournal(profile);
      }
    } catch (error) {
      console.error('Restore cleanup failed', error);
    }
    try {
      if (previous) await this.finishRestore(previous, target);
    } finally {
      this.end();
    }
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
    await step('Resuming jobs failed', async () => {
      await this.current.jobs.resume();
      this.current.channels.followResumedBacklogs();
    });
    await step('Schedule start failed', () => this.current.schedule.start());
    this.lastExportedAt = await readLastExport(this.options.profilePath, this.current.root);
    this.previousPaths = await previousLocations(this.options.profilePath, this.current.vaultId);
    return { interruptedJobs, resumedJobs: this.current.jobs.unfinishedCount() };
  }

  /** Settles the switch to a restored Vault; the previous Vault's jobs continue when it is opened again. */
  private async finishRestore(previous: Bundle, target: string): Promise<void> {
    const { interruptedJobs } = await this.switchTo(previous, {
      reason: '切換到還原的知識庫時工作尚未完成；回到原知識庫時接續。', stop: 'vault_switch', moved: false,
    });
    const jobs = interruptedJobs ? `原知識庫有 ${interruptedJobs} 個收集工作暫停，回到原知識庫時會接續。` : '';
    this.statusValue = {
      ...this.statusValue, state: 'completed', errorCode: null,
      message: `已還原到新的知識庫並切換使用，自動收集已暫停。原知識庫保留在 ${previous.root}。${jobs}`,
      result: { previousVaultPath: previous.root, interruptedJobs, autoCollectionPaused: true },
    };
    // Device-level, so both the previous and the restored Vault show the switch.
    this.record('info', 'vault.restored',
      `已從備份還原新的知識庫 ${target} 並切換使用，自動收集已暫停。原知識庫保留在 ${previous.root}。${jobs}`, null);
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
    this.preview = null;
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
      journal = { ...journal, phase: 'placed', marker: await markerDigest(journal.staging), emptyTarget: await pathExists(target) };
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
        if (journal?.emptyTarget && !await pathExists(target)) await mkdir(target);
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
   * previous location joins the Vault's history, the export time moves to the new path, and the
   * search database of the previous path is removed. Each step that fails is logged.
   */
  private async settleRelocation(vaultId: string, source: string, target: string): Promise<void> {
    const profile = this.options.profilePath;
    await step('Recording the previous location failed', () => recordPreviousLocation(profile, vaultId, source, target));
    await step('Carrying the export time failed', async () => {
      const time = await readLastExport(profile, source);
      if (time && !await readLastExport(profile, target)) await recordExport(profile, target, time);
    });
    await step('Previous search database removal failed', () => this.removeSearchData(source));
    if (this.current?.root === target) this.lastExportedAt = await readLastExport(profile, target);
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
      throw new CollectorError('invalid_request', '這是搬移或還原使用的暫存資料夾，不能當作知識庫開啟。請開啟搬移後的新位置。');
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
    this.preview = null;
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

  /** Compares a package file with the active Vault. */
  async previewMergeFrom(file: unknown): Promise<MergePreview> {
    return this.previewMerge(await readPackageFile(file));
  }

  async previewMerge(buffer: Buffer): Promise<MergePreview> {
    return this.run('merge', '比對', async () => {
      // A comparison refused for a busy Vault leaves the previous one usable.
      this.preview = null;
      this.progress('validating', '正在檢查備份…');
      let directory: string | null = null;
      const scratch = scratchParent(this.current.root);
      try {
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(path.join(scratch, 'preview-'));
        await unpackVault(buffer, directory, () => undefined, { pauseSchedule: false });
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        await rmdir(scratch).catch(() => undefined);
      }
      const local = await exportVault(this.current.root);
      const info = packageInfo(buffer);
      const value: MergePreview = {
        id: randomUUID(), items: compareFiles(packageFiles(local), packageFiles(buffer)),
        package: { version: info.version, exportedAt: info.exportedAt ?? null, createdBy: info.createdBy ?? null },
      };
      this.preview = { value, baseline: mergeBaseline(packageFiles(local), packageFiles(buffer)), incoming: buffer };
      this.statusValue = { ...this.statusValue, state: 'completed', message: '比對完成，請選擇差異的處理方式。' };
      return value;
    });
  }

  cancelMerge(id: string): void {
    if (this.locked) throw new CollectorError('vault_busy', '正在套用合併，請等待結果。');
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇資料包。');
    this.preview = null;
    this.statusValue = { ...this.statusValue, state: 'idle', operation: null, message: '已取消合併，資料未變更。', result: null };
  }

  applyMerge(id: string, choices: Record<string, MergeChoice>): TransferStatus {
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新比對。');
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new CollectorError('invalid_request', '合併選擇格式無效。');
    const preview = this.preview;
    this.lock('merge');
    this.operation = this.mergeOnce(preview, choices).catch((error: unknown) => this.fail(error, '合併')).finally(() => { this.operation = null; });
    return this.status();
  }

  private async atomicFile(file: string, bytes: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }

  private async recoverMerge(root: string): Promise<boolean> {
    const journal = `${root}.merge-journal.json`;
    let data: { backup: string; paths: string[] };
    try { data = JSON.parse(await readFile(journal, 'utf8')) as typeof data; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!data || typeof data.backup !== 'string' || !Array.isArray(data.paths)
      || !data.paths.every((entry) => typeof entry === 'string' && safePath(entry))) {
      throw new Error('Invalid merge recovery journal');
    }
    const backup = await readFile(data.backup);
    const scratch = scratchParent(root);
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const validation = await mkdtemp(path.join(scratch, 'recovery-'));
    try { await unpackVault(backup, validation, () => undefined, { pauseSchedule: false, recovery: true }); }
    finally {
      await rm(validation, { recursive: true, force: true });
      await rmdir(scratch).catch(() => undefined);
    }
    const files = packageFiles(backup);
    for (const relative of data.paths) {
      const target = path.join(root, relative);
      let entries: string[];
      try { entries = await readdir(path.dirname(target)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries = []; }
      for (const name of entries) {
        const prefix = `${path.basename(target)}.`;
        if (name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/u.test(name.slice(prefix.length))) {
          await rm(path.join(path.dirname(target), name), { force: true });
        }
      }
      const original = files.get(relative);
      if (original) await this.atomicFile(path.join(root, relative), original);
      else await rm(path.join(root, relative), { force: true });
    }
    // Keep the journal until the caller has also repaired the search projection.
    return true;
  }

  private async mergeOnce(preview: NonNullable<VaultWorkspace['preview']>, choices: Record<string, MergeChoice>): Promise<void> {
    const root = this.current.root;
    const journal = `${root}.merge-journal.json`;
    let journalWritten = false;
    let safeToResume = true;
    try {
      await this.settleCollection();
      this.progress('validating', '正在檢查本機資料…');
      const before = await exportVault(root);
      if (mergeBaseline(packageFiles(before), packageFiles(preview.incoming)) !== preview.baseline) {
        this.preview = null;
        throw new CollectorError('invalid_request', '本機資料在比對後有變更，請重新比對。');
      }
      const changes = mergeFiles(packageFiles(before), packageFiles(preview.incoming), preview.value.items, choices);
      if (!changes.size) {
        this.preview = null;
        this.statusValue = { ...this.statusValue, state: 'completed', message: '合併完成，沒有需要寫入的變更。', result: { writtenFiles: 0 } };
        this.record('info', 'vault.merged', '合併完成，沒有需要寫入的變更。');
        return;
      }
      const backup = `${root}.before-merge-${randomUUID()}.xr-vault`;
      await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
      await this.atomicFile(journal, Buffer.from(JSON.stringify({ backup, paths: [...changes.keys()] })));
      journalWritten = true;
      this.mergeWriting = true;
      this.statusValue = { ...this.statusValue, state: 'extracting', message: '正在合併資料…', completedFiles: 0, totalFiles: changes.size };
      for (const [relative, bytes] of changes) {
        if (bytes) await this.atomicFile(path.join(root, relative), bytes);
        else await rm(path.join(root, relative), { force: true });
        this.statusValue.completedFiles += 1;
      }
      this.progress('indexing', '正在更新搜尋索引…');
      const vault = new MarkdownVault(root);
      for (const [relative, bytes] of changes) {
        const id = documentIdFromPath(relative);
        if (!id) continue;
        if (!bytes) {
          await this.current.runtime.search.remove(id);
          continue;
        }
        const document = await vault.read(id);
        if (!document) throw new Error('Merged document missing');
        await this.current.runtime.search.index(document);
      }
      await this.reloadSchedule();
      await rm(journal);
      journalWritten = false;
      this.preview = null;
      this.statusValue = {
        ...this.statusValue, state: 'completed', message: `合併完成，寫入 ${changes.size} 個檔案。合併前的資料已備份到 ${backup}`,
        result: { writtenFiles: changes.size, mergeBackupPath: backup },
      };
      this.record('info', 'vault.merged', `合併完成，寫入 ${changes.size} 個檔案。合併前的資料已備份到 ${backup}`);
    } catch (error) {
      if (journalWritten) {
        try {
          await this.recoverMerge(root);
          await this.current.runtime.search.rebuild();
          await this.reloadSchedule();
          await rm(journal);
        } catch {
          safeToResume = false;
          throw new CollectorError('vault_busy', `合併未完成，已停止寫入與排程。請重新啟動以復原；復原紀錄：${journal}`);
        }
      }
      throw error;
    } finally {
      if (safeToResume) { this.mergeWriting = false; this.end(); }
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
      message: error instanceof CollectorError ? error.message : '操作失敗，請確認備份檔案、磁碟空間與搜尋服務後重試。',
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
    const { id: vaultId, created } = await ensureVaultId(root);
    // Only a Vault given its first ID here is one that existed before Vaults had IDs; a moved or
    // restored Vault already has its ID and never takes over jobs recorded at its path.
    if (vaultId && created) {
      this.jobStore.claim(root, vaultId);
    } else if (!vaultId) {
      this.jobStore.event({
        severity: 'warning', eventType: 'vault.unidentified', vaultPath: root, jobId: null,
        message: '無法在知識庫標記檔寫入識別碼；知識庫照常使用，但暫時無法搬移或開啟其他知識庫。請確認資料夾可以寫入。',
      });
    }
    await migrateSubscriptionSettings(root);
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
      legacySettings: () => readLegacySettings(root),
      checkChannel: async (channelId) => (await bundle.channels.startRun({ trigger: 'manual', channelIds: [channelId] }))[0]!,
      ...(this.options.jobLimits ? { limits: this.options.jobLimits } : {}),
      ...(this.options.jobRetry ? { retry: this.options.jobRetry } : {}),
    });
    const channels = new ChannelCollector(channelStore, jobs, {
      autoCollection, resolveChannel: (url) => source.resolveChannel(url), documents: () => collector.list(),
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
    const drained = await Promise.allSettled([
      this.current.schedule.close(),
      this.current.jobs.close(),
    ]);
    const search = await Promise.allSettled([this.current.runtime.close()]);
    const failed = [...drained, ...search].find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Scratch space for merge previews and recovery checks, beside a Vault and never inside it. */
function scratchParent(root: string): string {
  return `${root}.restored`;
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

async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

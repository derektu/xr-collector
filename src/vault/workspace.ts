import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Collector } from '../core/collector.js';
import {
  CollectorError, type MergePreview, type MergeChoice, type TransferOperation, type TransferResult, type TransferStatus, type TranscriptSearch,
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
import { compareFiles, fingerprint, packageFiles, mergeFiles } from './vault-merge.js';
import { exportVault, packageInfo, unpackVault, safePath } from './vault-package.js';
import { documentIdFromPath } from './document-paths.js';
import {
  checkExportFile, checkRestoreFolder, clearRestoreJournal, readLastExport, readPackageFile, recordExport, recoverRestore,
  stagingFolder, suggestRestoreFolder, writePackageFile, writeRestoreJournal,
} from './transfer-files.js';
import { writeVaultMarker } from './vault-directory.js';
import type { VaultSelection } from './vault-selection.js';

interface Bundle {
  root: string;
  collector: Collector;
  channels: ChannelCollector;
  jobs: JobManager;
  schedule: ChannelScheduler;
  runtime: SearchRuntime;
}
export interface WorkspaceOptions {
  /** Absolute path of a Vault that the caller has already inspected. */
  root: string;
  /** Device record updated when a restore switches the active Vault. */
  selection: VaultSelection;
  /** Device profile folder: the export times and the record of a restore in progress live here. */
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
}

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
  private lastExportedAt: string | null = null;
  private statusValue: Omit<TransferStatus, 'vaultPath' | 'lastExportedAt'> = {
    state: 'idle', operation: null, message: '', completedFiles: 0, totalFiles: 0, result: null,
  };
  readonly collector = forwarding(() => this.current.collector);
  readonly channels = forwarding(() => this.current.channels);
  readonly jobs = forwarding(() => this.current.jobs);
  readonly schedule = forwarding(() => this.current.schedule);
  readonly search = forwarding<TranscriptSearch>(() => this.current.runtime.search);
  /** Scratch space for merge previews and recovery checks, beside the Vault and never inside it. */
  private readonly scratchParent: string;
  private readonly jobStore: JobStore;
  private readonly holdTimeoutMs: number | undefined;

  private constructor(private readonly options: WorkspaceOptions) {
    this.scratchParent = `${options.root}.restored`;
    this.jobStore = options.jobStore ?? JobStore.memory();
    this.holdTimeoutMs = options.holdTimeoutMs;
  }

  static async open(options: WorkspaceOptions): Promise<VaultWorkspace> {
    const workspace = new VaultWorkspace(options);
    const root = options.root;
    await recoverRestore(options.profilePath);
    const recovered = await workspace.recoverMerge(root);
    workspace.current = await workspace.makeBundle(root, options.searchPort);
    workspace.lastExportedAt = await readLastExport(options.profilePath, root);
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
    return { ...this.statusValue, vaultPath: this.current.root, lastExportedAt: this.lastExportedAt };
  }

  assertReadable(): void {
    if (this.mergeWriting) throw new CollectorError('vault_busy', '正在合併或復原資料，請稍後再讀取。');
  }

  /** Acquired by HTTP writes before any handler can yield. */
  enterWrite(): () => void {
    if (this.locked) throw new CollectorError('vault_busy', '正在備份、還原或合併知識庫，請等它完成後再操作。');
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
      throw new CollectorError('vault_busy', '正在進行其他知識庫操作，請等它完成後再備份、還原或合併。');
    }
    this.locked = true;
    this.current.schedule.setSuspended(true);
    this.statusValue = {
      state: 'waiting', operation, message: '正在等待目前的收集步驟完成…', completedFiles: 0, totalFiles: 0, result: null,
    };
  }

  /** Waits for the collection steps and the subscription check already running. */
  private async settleCollection(): Promise<void> {
    this.releaseJobs = await this.current.jobs.hold(this.holdTimeoutMs);
    await this.current.schedule.idle();
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
    let staging: string | null = null;
    let placed = false;
    let targetExisted = false;
    let candidate: Bundle | null = null;
    try {
      await this.settleCollection();
      this.progress('validating', '正在檢查備份…');
      staging = stagingFolder(target);
      await writeRestoreJournal(profile, staging);
      await mkdir(staging, { mode: 0o700 });
      await unpackVault(buffer, staging, (done, total) => {
        this.statusValue = { ...this.statusValue, state: 'extracting', message: '正在還原檔案…', completedFiles: done, totalFiles: total };
      });
      await writeVaultMarker(staging, this.options.createdBy);
      // The chosen folder holds at most entries a file manager adds by itself; the staging folder takes its place.
      await checkRestoreFolder(target, this.folders);
      targetExisted = await pathExists(target);
      if (targetExisted) await rm(target, { recursive: true });
      await rename(staging, target);
      placed = true;
      staging = null;
      await clearRestoreJournal(profile);
      this.progress('indexing', '正在建立新知識庫的搜尋索引…');
      candidate = await this.makeBundle(target);
      // The candidate owns a separate search database; failed preparation leaves the active vault intact.
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
      await this.options.selection.write(target);
      placed = false;
      const previous = this.current;
      const interruptedJobs = previous.jobs.unfinishedCount();
      this.releaseJobs = null;
      this.current = candidate;
      candidate = null;
      this.lastExportedAt = await readLastExport(profile, target);
      await this.current.schedule.start();
      await previous.schedule.close();
      await previous.jobs.close();
      await previous.runtime.close().catch((error: unknown) => console.error('Previous search shutdown failed', error));
      const jobs = interruptedJobs ? `原知識庫有 ${interruptedJobs} 個收集工作暫停，回到原知識庫時會接續。` : '';
      this.statusValue = {
        ...this.statusValue, state: 'completed',
        message: `已還原到新的知識庫並切換使用，自動收集已暫停。原知識庫保留在 ${previous.root}。${jobs}`,
        result: { previousVaultPath: previous.root, interruptedJobs, autoCollectionPaused: true },
      };
      // Device-level, so both the previous and the restored Vault show the switch.
      this.record('info', 'vault.restored',
        `已從備份還原新的知識庫 ${target} 並切換使用，自動收集已暫停。原知識庫保留在 ${previous.root}。${jobs}`, null);
    } catch (error) {
      this.fail(error, '還原');
    } finally {
      try {
        if (candidate) {
          await candidate.schedule.close();
          await candidate.jobs.close();
          await candidate.runtime.close();
        }
        // A restore that fails after placing its folder takes it back, leaving the chosen folder as it was.
        if (placed) {
          staging = stagingFolder(target);
          await writeRestoreJournal(profile, staging);
          await rename(target, staging);
          if (targetExisted) await mkdir(target);
          await rm(this.searchPath(target), { recursive: true, force: true });
        }
        if (staging) await rm(staging, { recursive: true, force: true });
        await clearRestoreJournal(profile);
      } catch (error) {
        console.error('Restore cleanup failed', error);
      } finally {
        this.end();
      }
    }
  }

  /** Compares a package file with the active Vault. */
  async previewMergeFrom(file: unknown): Promise<MergePreview> {
    return this.previewMerge(await readPackageFile(file));
  }

  async previewMerge(buffer: Buffer): Promise<MergePreview> {
    this.preview = null;
    return this.run('merge', '比對', async () => {
      this.progress('validating', '正在檢查備份…');
      let directory: string | null = null;
      try {
        await mkdir(this.scratchParent, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(path.join(this.scratchParent, 'preview-'));
        await unpackVault(buffer, directory, () => undefined, { pauseSchedule: false });
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        await rmdir(this.scratchParent).catch(() => undefined);
      }
      const local = await exportVault(this.current.root);
      const info = packageInfo(buffer);
      const value: MergePreview = {
        id: randomUUID(), items: compareFiles(packageFiles(local), packageFiles(buffer)),
        package: { version: info.version, exportedAt: info.exportedAt ?? null, createdBy: info.createdBy ?? null },
      };
      this.preview = { value, baseline: fingerprint(local), incoming: buffer };
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
    await mkdir(this.scratchParent, { recursive: true, mode: 0o700 });
    const validation = await mkdtemp(path.join(this.scratchParent, 'recovery-'));
    try { await unpackVault(backup, validation, () => undefined, { pauseSchedule: false, recovery: true }); }
    finally {
      await rm(validation, { recursive: true, force: true });
      await rmdir(this.scratchParent).catch(() => undefined);
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
      if (fingerprint(before) !== preview.baseline) {
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
    this.statusValue = { ...this.statusValue, state: 'error', result: null, message: error instanceof CollectorError
      ? error.message : '操作失敗，請確認備份檔案、磁碟空間與搜尋服務後重試。' };
    this.record('error', 'vault.transfer_failed', `${operation}失敗：${this.statusValue.message}`,
      undefined, error instanceof CollectorError ? error.code : undefined);
  }

  /** Records a Vault operation in the device activity log, under the active Vault unless `vaultPath` says otherwise. */
  private record(severity: 'info' | 'error', eventType: string, message: string, vaultPath?: string | null, errorCode?: string): void {
    this.jobStore.event({
      severity, eventType, message, vaultPath: vaultPath === undefined ? this.current.root : vaultPath, jobId: null,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  /** Each Vault path gets its own rebuildable search database on this device. */
  private searchPath(root: string): string {
    return `${this.options.searchData}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  }

  private async makeBundle(root: string, port?: number): Promise<Bundle> {
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
    const partial = { root, runtime, collector, channels, jobs };
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

function makeScheduler(bundle: Pick<Bundle, 'root' | 'channels' | 'jobs'>): ChannelScheduler {
  return new ChannelScheduler(bundle.channels, new JsonChannelScheduleStore(bundle.root), {
    recordEvent: (entry) => bundle.jobs.recordEvent(entry),
  });
}

async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

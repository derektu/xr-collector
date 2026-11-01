import type { NoteChange } from '../core/change-feed.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Collector } from '../core/collector.js';
import {
  CollectorError, type ChangeCounts, type ExportSuggestion, type ImportMode, type ImportPreview,
  type TransferOperation, type TransferResult, type TransferStatus, type TranscriptSearch,
} from '../core/types.js';
import { subscriptionDefinitions } from '../core/source-registry.js';
import { SubscriptionService, SubscriptionServices } from '../subscriptions/subscription-service.js';
import { forwardingPort } from '../jobs/subscription-port.js';
import { CollectionScheduler } from '../subscriptions/scheduler.js';
import { JsonSubscriptionStore, type SubscriptionStore } from '../subscriptions/subscription-store.js';
import { JsonScheduleStore } from '../subscriptions/schedule-store.js';
import { canonicalJson } from '../subscriptions/subscription-files.js';
import { RecentTargets } from '../subscriptions/recent-targets.js';
import { JobManager, type JobLimits, type RetryPolicy } from '../jobs/job-manager.js';
import type { Pacing } from '../pacing/pacing-gate.js';
import type { CollectionPause } from '../core/collection-pause.js';
import type { Connectivity } from '../core/connectivity.js';
import type { SourcePlugin } from '../plugins/types.js';
import { JobStore } from '../jobs/job-store.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { prepareOwnedSearchProjection, searchDatabasePath } from '../search/search-projection.js';
import { MarkdownVault } from './markdown-vault.js';
import { deletionId } from './deleted-documents.js';
import { changeTotal, chosenKeys, compareItems, itemStates, planChanges, type Comparison, type ImportPlan, type ItemStates } from './vault-merge.js';
import { applyInPlace, checkFreeSpace, finishInPlaceImports, type ImportFault } from './vault-import.js';
import {
  checkPackageContent, machineName, openPackage, registeredFiles, registeredSource, writePackage, type PackageReader, type WrittenPackage,
} from './vault-package.js';
import { documentIdFromPath } from './document-paths.js';
import {
  checkExportFile, checkPackageFile, exportFileName, isWithin, isWorkFolder, backupFileName, recoverImport,
} from './transfer-files.js';
import { inspectVaultDirectory, notAVault, readVaultId } from './vault-directory.js';
import { createNewVault, newVaultFolder } from './new-vault.js';
import type { StatFs } from './disk-space.js';
import type { VaultSelection } from './vault-selection.js';
import {
  VaultOperationLock, type OperationCompletion, type OperationReporter, type OperationTerminal, type UpdateLease, type VaultAccess,
} from './operation-lock.js';

interface Bundle {
  root: string;
  /** ID from the Vault's marker. */
  vaultId: string;
  collector: Collector;
  subscriptions: SubscriptionServices;
  jobs: JobManager;
  schedule: CollectionScheduler;
  runtime: SearchRuntime;
}
export interface WorkspaceOptions {
  /** Absolute path of a Vault that the caller has already inspected. */
  root: string;
  /** Device record of the active Vault; writing it is the commit point of a switch. */
  selection: VaultSelection;
  /** Device profile folder, where the journal of an import from Onboarding in progress lives. */
  profilePath: string;
  /** Folder exports go to when no other place is chosen. */
  exportFolder: string;
  /** Folder an import backs the Vault up to before it applies. */
  backupFolder: string;
  /** Name of this machine in exports and the activity log; defaults to `machineName()`. */
  machineName?: string;
  /** How long a transfer waits for running collection steps; defaults to the job manager's limit. */
  holdTimeoutMs?: number;
  /** Application name and version written into markers of Vaults it creates. */
  createdBy: string;
  /** The assembled source plugins every job of this workspace collects through. */
  plugins: readonly SourcePlugin[];
  searchBinary: string;
  /** External main lexicon. Production callers provide its resource path; tests may replace search entirely. */
  searchLexicon?: string;
  searchData: string;
  searchPort?: number;
  /** Replaces the search engine; `statusChanged` is called on each change of its status. */
  createSearch?: (root: string, statusChanged: () => void) => Promise<SearchRuntime>;
  /** Device record of collection jobs; defaults to an in-memory store. */
  jobStore?: JobStore;
  jobLimits?: Partial<JobLimits>;
  /** The device's request channels, one per pacing group, that the plugins above share. */
  pacing?: readonly Pacing[];
  /** The device's collection pause, followed by the scheduler and jobs of every Vault this workspace opens. */
  pause?: CollectionPause;
  /** The device's network, confirmed by the jobs of every Vault this workspace opens after a request fails for lack of it. */
  connectivity?: Connectivity;
  jobRetry?: Partial<RetryPolicy>;
  /**
   * The Vault location was fixed when the app started (`XR_COLLECTOR_VAULT`). The next start opens
   * that location again, so no other Vault is created or opened.
   */
  fixedLocation?: boolean;
  /** Free space of a volume; defaults to `fs.statfs`. */
  statfs?: StatFs;
  /** Called at each step of an in-place import, for tests that make a step fail or stop there; see `ImportFault`. */
  importFaults?: (phase: ImportFault, count?: number) => void | Promise<void>;
  /**
   * The Vault was just created by an import from Onboarding that is complete only once the caller
   * writes the device selection. Opening it leaves the import journal in the profile, so a failure
   * or a stop before that write still lets the import be taken back.
   */
  pendingImport?: boolean;
  /** Hears each change of the Vault's data and of its operation status, once reads return it. */
  noteChange?: NoteChange;
  /** Device-profile notification sink; Vault data never contains notification delivery state. */
  onAutoPaused?: (vaultId: string, sourceType: string, subscription: import('../core/types.js').SubscriptionRecord) => void | Promise<void>;
}

/**
 * An import comparison waiting to be applied: the export file it compared, what it found, and a
 * digest of the local items and the file it stands on.
 */
interface Preview { value: ImportPreview; comparison: Comparison; baseline: string; file: string; identity: string }

/** An import whose journal may be written: what it changes and what it reports once its files are in place. */
interface AppliedImport {
  preview: Preview;
  mode: ImportMode;
  counts: ChangeCounts;
  plan: ImportPlan;
  backup: string;
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

/**
 * One collection per source type with subscriptions, each forwarding to that type's service of
 * whatever Vault `services` returns at call time. A collection names its type without reaching the
 * Vault, so routes can be laid out before one is open.
 */
export function subscriptionCollections(services: () => SubscriptionServices): SubscriptionService[] {
  return subscriptionDefinitions().map(({ id: type }) => new Proxy({} as SubscriptionService, {
    get(_object, key) {
      if (key === 'type') return type;
      const service = services().of(type);
      if (!service) throw new Error(`Source type ${type} has no subscription service`);
      const value: unknown = Reflect.get(service, key);
      return typeof value === 'function' ? value.bind(service) : value;
    },
  }));
}

export class VaultWorkspace {
  private current!: Bundle;
  private preview: Preview | null = null;
  private readonly operationLock: VaultOperationLock;
  readonly collector = forwarding(() => this.current.collector);
  readonly subscriptions = forwarding(() => this.current.subscriptions);
  readonly jobs = forwarding(() => this.current.jobs);
  readonly schedule = forwarding(() => this.current.schedule);
  readonly search = forwarding<TranscriptSearch>(() => this.current.runtime.search);
  private readonly jobStore: JobStore;
  private readonly holdTimeoutMs: number | undefined;

  private constructor(private readonly options: WorkspaceOptions) {
    this.jobStore = options.jobStore ?? JobStore.memory();
    this.holdTimeoutMs = options.holdTimeoutMs;
    this.machine = options.machineName ?? machineName();
    this.operationLock = new VaultOperationLock({
      hold: (signal) => this.current.jobs.hold(this.holdTimeoutMs, signal),
      idle: () => this.current.schedule.idle(),
      suspend: (value) => this.current.schedule.setSuspended(value),
      changed: () => {
        const status = this.operationLock.status();
        this.noteChange({ kind: 'vault', scope: 'transfer' });
        // A finished import or switch replaced what every page shows.
        if (status.state === 'completed' && status.operation !== 'export') this.noteChange({ kind: 'vault', scope: 'contents' });
      },
    });
  }

  private readonly noteChange: NoteChange = (change) => this.options.noteChange?.(change);

  /** Active Vault subscription rows for device-profile notification reconciliation. */
  async notificationSubscriptions(): Promise<Array<{ vaultId: string; sourceType: string; subscription: import('../core/types.js').SubscriptionRecord }>> {
    const rows: Array<{ vaultId: string; sourceType: string; subscription: import('../core/types.js').SubscriptionRecord }> = [];
    for (const service of this.current.subscriptions.all()) {
      for (const subscription of await service.list()) rows.push({ vaultId: this.current.vaultId, sourceType: service.type, subscription });
    }
    return rows;
  }
  activeVaultId(): string { return this.current.vaultId; }
  private readonly machine: string;

  static async open(options: WorkspaceOptions): Promise<VaultWorkspace> {
    const workspace = new VaultWorkspace(options);
    const root = options.root;
    const selected = await options.selection.read().catch(() => null);
    // The selected Vault and the one being opened are never taken back, whatever the journal says.
    if (!options.pendingImport) await recoverImport(options.profilePath, [selected, root]);
    // An import a stop interrupted after its commit point is finished before anything reads the Vault.
    const finished = await finishInPlaceImports(root);
    workspace.current = await workspace.makeBundle(root, options.searchPort);
    try {
      if (finished) await workspace.current.runtime.search.rebuild();
      // Interrupted jobs continue before the scheduler can submit a check of the same subscription.
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
      ...this.operationLock.status(), vaultPath: this.current.root,
      relocationUnavailable: problem ? { code: problem.code, message: problem.message } : null,
    };
  }

  /** Which activity belongs to the active Vault: its ID and its path. */
  activityScope(): { vaultPath: string; vaultId: string } {
    return { vaultPath: this.current.root, vaultId: this.current.vaultId };
  }

  /** Why no other Vault can be created or opened in place of the active one; null when it can. */
  private relocationProblem(): CollectorError | null {
    if (this.options.fixedLocation) {
      return new CollectorError('vault_location_fixed', '這次啟動指定了固定的知識庫位置，無法建立或開啟其他知識庫。');
    }
    return null;
  }

  /** Acquired by HTTP requests before any handler can yield. */
  enterRequest(access: VaultAccess): () => void { return this.operationLock.enter(access); }

  /** Excludes transfers and new writes, then waits for current writes and collection to settle. */
  prepareUpdate(signal: AbortSignal): Promise<UpdateLease> { return this.operationLock.prepareUpdate(signal); }

  /** Direct callers use the same write lease as an undeclared non-GET HTTP route. */
  enterWrite(): () => void { return this.enterRequest('vault-write'); }

  /** Direct callers use the same read check as an undeclared GET HTTP route. */
  assertReadable(): void { this.enterRequest('vault-read')(); }

  /** Resolves once the current background Vault operation has published its final state. */
  async operationFinished(): Promise<void> {
    await this.operationLock.finished();
    await this.jobStore.flush();
  }

  private get folders() {
    return { vaultRoot: this.current.root, profilePath: this.options.profilePath };
  }

  /**
   * Cancels the transfer that is still waiting for collection steps: collection continues, nothing
   * is written, and the status returns to idle. A transfer past the wait runs to its end.
   */
  cancelWait(): TransferStatus {
    this.operationLock.cancelWait();
    return this.status();
  }

  /** Runs one transfer step under the lock; the lock is released whether it succeeds or fails. */
  private run<T>(operation: TransferOperation, label: string, body: (reporter: OperationReporter) => Promise<OperationCompletion<T>>): Promise<T> {
    return this.operationLock.start({
      operation, body, failed: (error) => this.failure(error, label),
      cancelled: () => this.record('info', 'vault.transfer_cancelled', `已取消${label}，資料未變更。`),
    });
  }

  /** Where an export goes when no other place is chosen: the export folder and a file name of today. */
  exportSuggestion(): ExportSuggestion {
    const folder = this.options.exportFolder;
    return { folder, path: path.join(folder, exportFileName(new Date())) };
  }

  /**
   * Writes the export of the active Vault to `file`, or to the suggested file in the export folder
   * when `file` is left out; an existing file is replaced only with `overwrite`. The export only
   * reads the Vault.
   */
  async exportTo(file?: unknown, overwrite = false): Promise<TransferStatus> {
    let requested = file;
    if (requested === undefined || requested === null) {
      await mkdir(this.options.exportFolder, { recursive: true });
      requested = this.exportSuggestion().path;
    }
    const target = await checkExportFile(requested, overwrite, this.folders);
    await this.run('export', '匯出', async (reporter) => {
      // Written beside the target and renamed, so the named file is either a whole export or untouched.
      const temporary = `${target}.${randomUUID()}.tmp`;
      let written: WrittenPackage;
      try {
        written = await this.pack(temporary, new Date(), reporter);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      const result: TransferResult = { exportPath: target, exportBytes: (await stat(target)).size, unregisteredFiles: written.unregisteredFiles };
      const others = result.unregisteredFiles ? `知識庫資料夾中有 ${result.unregisteredFiles} 個不屬於知識庫的檔案沒有包含。` : '';
      this.record('info', 'vault.exported', `已匯出知識庫：${target}${others}`);
      return { value: undefined, message: `已匯出：${target}${others}`, result };
    });
    return this.status();
  }

  private async pack(file: string, exportedAt: Date, reporter: OperationReporter): Promise<WrittenPackage> {
    reporter.progress('exporting', '正在匯出…');
    return writePackage(this.current.root, file, {
      createdBy: this.options.createdBy, exportedAt, source: { vaultId: this.current.vaultId, machine: this.machine, folderName: path.basename(this.current.root) },
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
    this.current = candidate;
    return previous;
  }

  /**
   * Settles a committed switch: stops the previous Vault's scheduler, jobs and search, then continues
   * the unfinished jobs of the Vault now in use and starts its scheduler. The previous jobs are
   * recorded as interrupted with `reason`. Each step that fails is logged and the switch still
   * completes, because the selection already names the new Vault.
   */
  private async switchTo(previous: Bundle, reason: string): Promise<{ interruptedJobs: number; resumedJobs: number }> {
    const interruptedJobs = previous.jobs.unfinishedCount();
    await step('Previous schedule shutdown failed', () => previous.schedule.close());
    await step('Previous jobs shutdown failed', () => previous.jobs.close(reason, 'vault_switch'));
    await step('Previous search shutdown failed', () => previous.runtime.close());
    await step('Resuming jobs failed', () => this.current.jobs.resume());
    await step('Schedule start failed', () => this.current.schedule.start());
    return { interruptedJobs, resumedJobs: this.current.jobs.unfinishedCount() };
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
      throw new CollectorError('invalid_request', '這是匯入使用的暫存資料夾，不能當作知識庫開啟。');
    }
    if (await isWithin(root, this.current.root)) {
      throw new CollectorError('invalid_request', await isWithin(this.current.root, root)
        ? '這就是目前使用中的知識庫。' : '不能開啟目前知識庫裡的資料夾。');
    }
    if (await isWithin(root, this.options.profilePath)) throw new CollectorError('invalid_request', '不能開啟程式資料目錄裡的資料夾。');
    const inspection = await inspectVaultDirectory(root);
    if (inspection.kind !== 'existing') throw new CollectorError('vault_invalid', notAVault(inspection));
    this.dropPreview();
    void this.run('open', '開啟其他知識庫', (reporter) => this.openOnce(inspection.path, reporter)).catch(() => undefined);
    return this.status();
  }

  /**
   * Creates the new Vault folder `name` in `location` and switches to it; progress is in `status`.
   * The folder is checked before anything stops, and a switch that fails removes the new folder, so
   * the active Vault stays in use and the location stays as it was.
   */
  async createNew(location: unknown, name: unknown): Promise<TransferStatus> {
    const problem = this.relocationProblem();
    if (problem) throw problem;
    const folders = { vaultRoot: this.current.root, profilePath: this.options.profilePath };
    await newVaultFolder(location, name, folders);
    this.dropPreview();
    void this.run('create', '建立知識庫', async (reporter) => {
      const root = await createNewVault(location, name, this.options.createdBy, folders);
      try {
        return await this.openOnce(root, reporter, 'created');
      } catch (error) {
        // Once the switch committed, the new Vault is the one in use and stays.
        if (this.current.root !== root) {
          await rm(root, { recursive: true, force: true }).catch((cleanup: unknown) => console.error('Removing the new Vault failed', cleanup));
        }
        throw error;
      }
    }).catch(() => undefined);
    return this.status();
  }

  private async openOnce(root: string, reporter: OperationReporter, how: 'opened' | 'created' = 'opened'): Promise<OperationCompletion<void>> {
    let candidate: Bundle | null = null;
    let previous: Bundle | null = null;
    try {
      reporter.progress('indexing', '正在開啟知識庫並建立搜尋索引…');
      // An import a stop interrupted after its commit point is finished before anything reads the Vault;
      // the rebuild below then indexes the finished content.
      await finishInPlaceImports(root);
      candidate = await this.makeBundle(root);
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
      previous = await this.commit(candidate);
      reporter.discardHold();
      candidate = null;
    } catch (error) {
      if (!(error instanceof CollectorError)) console.error('Opening another Vault failed', error);
      const failure = error instanceof CollectorError ? error
        : new CollectorError('vault_invalid', `無法開啟 ${root}，請確認資料夾與搜尋服務後重試。目前的知識庫不變。`);
      if (candidate) {
        await step('Candidate schedule shutdown failed', () => candidate!.schedule.close());
        await step('Candidate jobs shutdown failed', () => candidate!.jobs.close());
        await step('Candidate search shutdown failed', () => candidate!.runtime.close());
      }
      throw failure;
    }
    const { interruptedJobs, resumedJobs } = await this.switchTo(previous, '切換到其他知識庫時工作尚未完成；回到這個知識庫時接續。');
    const paused = interruptedJobs ? `它的 ${interruptedJobs} 個收集工作已暫停，回到原知識庫時接續。` : '';
    const resumed = resumedJobs ? `這個知識庫有 ${resumedJobs} 個收集工作接續。` : '';
    const message = `已${how === 'created' ? '建立並開啟' : '開啟'}知識庫 ${root}。原知識庫保留在 ${previous.root}。${paused}${resumed}`;
    const result: TransferResult = { previousVaultPath: previous.root, interruptedJobs, resumedJobs };
    // Device-level, so both Vaults show the switch.
    this.record('info', how === 'created' ? 'vault.created' : 'vault.opened', message, null);
    return { value: undefined, message, result };
  }

  /**
   * Compares an export file with the active Vault and keeps the comparison for `applyImport`. The
   * file stays where it is; the comparison is dropped when another Vault operation starts.
   */
  async previewImport(file: unknown): Promise<ImportPreview> {
    const source = await checkPackageFile(file);
    return this.run('import', '匯入', async (reporter) => {
      // A comparison refused for a busy Vault leaves the previous one usable.
      this.dropPreview();
      reporter.progress('validating', '正在檢查匯出檔…');
      const reader = await openPackage(source);
      try {
        await checkPackageContent(reader);
        reporter.progress('validating', '正在比對…');
        const { comparison, baseline } = await this.compare(reader);
        const { exportedAt, source: from } = reader.manifest;
        const value: ImportPreview = {
          id: randomUUID(),
          package: { fileName: path.basename(source), exportedAt: exportedAt ?? null, machine: from?.machine ?? null },
          merge: comparison.merge, replace: comparison.replace, localNewer: comparison.localNewer,
          mergeRecords: comparison.mergeKeys.length > 0 && !changeTotal(comparison.merge),
        };
        this.preview = { value, comparison, baseline, file: source, identity: reader.identity };
        return { value, message: '比對完成。', result: null };
      } finally {
        reader.close();
      }
    });
  }

  /**
   * Compares the local items with the file's items. The baseline digest covers what an apply stands
   * on: the local items and the file. Collection progress and check times are no items, so a check
   * the scheduler runs after a preview leaves the baseline as it was.
   */
  private async compare(reader: PackageReader): Promise<{ comparison: Comparison; baseline: string; local: ItemStates; incoming: ItemStates }> {
    const local = await itemStates(registeredSource(await registeredFiles(this.current.root)));
    const incoming = await itemStates(reader);
    const comparison = compareItems(local, incoming);
    const baseline = createHash('sha256').update(canonicalJson([[...local], reader.identity])).digest('hex');
    return { comparison, baseline, local, incoming };
  }

  /** Forgets the comparison waiting to be applied. */
  private dropPreview(): void {
    this.preview = null;
  }

  cancelImport(id: string): void {
    if (this.operationLock.isLocked()) throw new CollectorError('vault_busy', '正在套用匯入，請等待結果。');
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    this.dropPreview();
    this.operationLock.setIdle('已取消匯入，資料未變更。');
  }

  /**
   * Applies a compared import in place: a merge takes every item whose state in the file is newer,
   * a replace makes every item what the file holds. Progress is in `status`.
   */
  applyImport(id: string, mode: unknown): TransferStatus {
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    if (mode !== 'merge' && mode !== 'replace') throw new CollectorError('invalid_request', 'mode 必須是 merge 或 replace。');
    const preview = this.preview;
    if (mode === 'merge' && !preview.comparison.mergeKeys.length) throw new CollectorError('invalid_request', '沒有需要匯入的內容。');
    if (mode === 'replace' && !preview.comparison.replaceKeys.length) throw new CollectorError('invalid_request', '本機內容已與匯入檔相同。');
    void this.run('import', '匯入', (reporter) => this.importOnce(preview, mode, reporter)).catch(() => undefined);
    return this.status();
  }

  /**
   * Exports the Vault as it is into the backup folder before an import changes it, so a wrong
   * import can be undone by importing this file.
   */
  private async backUp(reporter: OperationReporter): Promise<string> {
    const folder = this.options.backupFolder;
    await mkdir(folder, { recursive: true });
    const now = new Date();
    const name = backupFileName(now);
    let target = path.join(folder, name);
    for (let index = 2; await exists(target); index += 1) target = path.join(folder, name.replace(/\.zip$/u, ` (${index}).zip`));
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await this.pack(temporary, now, reporter);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return target;
  }

  private async importOnce(preview: Preview, mode: ImportMode, reporter: OperationReporter): Promise<OperationCompletion<void>> {
    const root = this.current.root;
    let reader: PackageReader | null = null;
    let applied: AppliedImport | null = null;
    try {
      reporter.progress('validating', '正在檢查本機資料…');
      reader = await openPackage(preview.file);
      const current = reader.identity === preview.identity ? await this.compare(reader) : null;
      if (!current || current.baseline !== preview.baseline) {
        this.dropPreview();
        throw new CollectorError('invalid_request', '本機資料或匯入檔在比對後有變更，請重新選擇匯入檔。');
      }
      const plan = await planChanges(registeredSource(await registeredFiles(root)), reader, chosenKeys(current.comparison, mode), current.local);
      const counts = mode === 'replace' ? current.comparison.replace : current.comparison.merge;
      reporter.progress('exporting', '正在匯出目前的內容…');
      const backup = await this.backUp(reporter);
      const incomingBytes = [...plan.changes.values()].reduce((sum, change) => sum + (!change ? 0
        : 'bytes' in change ? change.bytes.length : reader!.manifest.files.find((row) => row.path === change.incoming)?.size ?? 0), 0);
      await checkFreeSpace(root, incomingBytes, this.options.statfs);
      reporter.blockReads();
      applied = { preview, mode, counts, plan, backup };
      reporter.progress('extracting', '正在套用匯入的內容…', { completed: 0, total: plan.changes.size });
      await applyInPlace(root, reader, plan.changes, (done, total) => {
        reporter.files(done, total);
      }, this.options.importFaults);
      return await this.importApplied(applied, mode === 'replace', reporter);
    } catch (error) {
      if (!applied) throw error;
      // Past the journal, the import is carried out to its end; before it, the Vault was never touched.
      let finished: boolean;
      try {
        finished = await finishInPlaceImports(root);
      } catch (again) {
        console.error('Finishing an interrupted import failed', again);
        reporter.stop(new CollectorError('vault_busy', '匯入未完成，已停止寫入與排程。請重新啟動程式以完成匯入。'));
      }
      if (!finished) throw error;
      console.error('An import failed while it put files in place and was carried out to its end', error);
      return await this.importApplied(applied, true, reporter);
    } finally {
      reader?.close();
    }
  }

  /**
   * Completes an import whose files are in place: updates the search index (rebuilding it when
   * `rebuild` is set or an update fails), reloads the schedule and reports the import as done. An
   * index that cannot be rebuilt either leaves the import done, with the rebuild left to the person.
   */
  private async importApplied(applied: AppliedImport, rebuild: boolean, reporter: OperationReporter): Promise<OperationCompletion<void>> {
    reporter.progress('indexing', '正在更新搜尋索引…');
    let indexed = true;
    try {
      if (rebuild) await this.current.runtime.search.rebuild();
      else await this.indexChanged(applied.plan.changes);
      await this.reloadSchedule();
    } catch (error) {
      console.error('Updating the search index after an import failed; rebuilding it', error);
      try {
        await this.current.runtime.search.rebuild();
        await this.reloadSchedule();
      } catch (again) {
        console.error('Rebuilding the search index after an import failed', again);
        indexed = false;
      }
    }
    this.dropPreview();
    const { counts, mode, backup, plan } = applied;
    const summary = changeSummary(counts);
    const how = mode === 'replace' ? '已完全以匯入內容取代' : '匯入完成';
    const done = indexed ? `${how}：${summary}。` : `匯入已完成，搜尋索引需要重建：請到設定按「重建索引」，或重新啟動程式。${summary}。`;
    const message = `${done}匯入前的內容已備份到 ${backup}`;
    const result: TransferResult = {
      importMode: mode, imported: counts, writtenFiles: plan.changes.size, backupPath: backup, ...(indexed ? {} : { searchRebuildNeeded: true }),
    };
    const { fileName, machine } = applied.preview.value.package;
    const file = machine ? `${fileName}，來自 ${machine}` : fileName;
    this.record(indexed ? 'info' : 'warning', 'vault.imported', indexed
      ? `${how}（${file}）：${summary}。匯入前的內容已備份到 ${backup}`
      : `匯入已完成（${file}）：${summary}。搜尋索引需要重建：請到設定按「重建索引」，或重新啟動程式。匯入前的內容已備份到 ${backup}`);
    return { value: undefined, message, result };
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

  /** Restarts the schedule after an import; imported subscriptions arrive without a next check time and get one first. */
  private async reloadSchedule(): Promise<void> {
    await this.current.schedule.close();
    for (const service of this.current.subscriptions.all()) await service.planChecks({ overdue: false });
    this.current.schedule = makeScheduler(this.current, this.options.pause, this.noteChange);
    this.current.schedule.setSuspended(true);
    await this.current.schedule.start();
  }

  private failure(error: unknown, operation: string): OperationTerminal {
    const message = error instanceof CollectorError ? error.message : '操作失敗，請確認匯出檔、磁碟空間與搜尋服務後重試。';
    this.record('error', 'vault.transfer_failed', `${operation}失敗：${message}`,
      undefined, error instanceof CollectorError ? error.code : undefined);
    return { message, result: null, errorCode: error instanceof CollectorError ? error.code : null };
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
    return searchDatabasePath(this.options.searchData, root);
  }

  private async makeBundle(root: string, port?: number): Promise<Bundle> {
    const vaultId = await readVaultId(root);
    if (!vaultId) throw new CollectorError('vault_invalid', '知識庫標記檔沒有識別碼，不是目前支援的知識庫格式，無法開啟。');
    const vault = new MarkdownVault(root);
    // Deletions a stop left unfinished are settled before the search index is compared with the Vault.
    const recovery = await vault.recoverDeletions();
    const databasePath = this.searchPath(root);
    const searchChanged = () => this.noteChange({ kind: 'search' });
    const runtime = this.options.createSearch ? await this.options.createSearch(root, searchChanged) : await startSearchRuntime({
      vault, binaryPath: this.options.searchBinary, databasePath,
      lexiconPath: this.options.searchLexicon ?? path.resolve('resources/search/coct-main.txt'),
      prepareProjection: (profile) => prepareOwnedSearchProjection({
        searchData: this.options.searchData,
        vaultRoot: root,
        binaryPath: this.options.searchBinary,
        profile,
      }),
      ...(port ? { port } : {}),
      statusChanged: searchChanged,
    });
    const collector = new Collector(vault, runtime.search, { recordEvent: (entry) => jobs.recordEvent(entry), noteChange: this.noteChange });
    const plugins = this.options.plugins;
    const recentTargets = new RecentTargets();
    const stores: Record<string, SubscriptionStore> = {};
    for (const plugin of plugins) if (plugin.subscription && plugin.storage) stores[plugin.id] = new JsonSubscriptionStore(root, plugin.id, undefined, this.noteChange);
    // The scheduler is replaced after a merge, so switch reads go through the bundle.
    const autoCollection = () => bundle.schedule.isEnabled();
    // Jobs hold this bundle's own Vault objects, so they never write through to a Vault switched in later.
    const jobs = new JobManager({
      vaultPath: root,
      vaultId,
      store: this.jobStore,
      plugins,
      documents: collector,
      // The subscriptions are built with the jobs they dispatch to, so the port reaches them through the bundle.
      subscriptions: forwardingPort(() => bundle.subscriptions),
      ...(this.options.jobLimits ? { limits: this.options.jobLimits } : {}),
      ...(this.options.jobRetry ? { retry: this.options.jobRetry } : {}),
      ...(this.options.pacing ? { pacing: this.options.pacing } : {}),
      ...(this.options.pause ? { pause: this.options.pause } : {}),
      ...(this.options.connectivity ? { connectivity: this.options.connectivity } : {}),
      recentTarget: (type, url) => recentTargets.get(type, url),
    });
    const subscriptions = new SubscriptionServices(plugins.filter((plugin) => stores[plugin.id]).map((plugin) =>
      new SubscriptionService(plugin.id, stores[plugin.id]!, jobs, {
        autoCollection,
        resolveTarget: async (url, signal) => {
          const target = await plugin.resolveTarget!(url, { priority: 'interactive', signal });
          // The UI and the Agent subscribe with the preview's target address, so the target stands
          // for that address as well as the one previewed.
          recentTargets.remember(plugin.id, url, target);
          try {
            const targetInput = plugin.classify(target.url);
            if (targetInput.kind === 'subscription') recentTargets.remember(plugin.id, targetInput.url, target);
          } catch { /* an address the source type does not accept is resolved again when added */ }
          return target;
        },
        documents: () => collector.list(),
        deleteDocument: (id) => collector.delete(id),
        recordDeletion: (entry) => collector.recordDeletion(entry),
        ...(plugin.login ? { loginRequired: () => plugin.login!.status() === 'required' } : {}),
        ...(this.options.onAutoPaused ? { onAutoPaused: (record) => this.options.onAutoPaused!(vaultId, plugin.id, record) } : {}),
      })));
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
    const partial = { root, vaultId, runtime, collector, subscriptions, jobs };
    const bundle: Bundle = { ...partial, schedule: makeScheduler(partial, this.options.pause, this.noteChange) };
    return bundle;
  }

  async close(): Promise<void> {
    await this.operationFinished();
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

/** "文件：新增 2、更新 1、刪除 1；訂閱：新增 1", for the activity log; "沒有變更" when nothing changes. */
function changeSummary(counts: ChangeCounts): string {
  const part = (label: string, kind: ChangeCounts['documents']) => {
    const items = [['新增', kind.added], ['更新', kind.updated], ['刪除', kind.removed]].filter(([, count]) => count)
      .map(([verb, count]) => `${verb} ${count}`);
    return items.length ? `${label}：${items.join('、')}` : null;
  };
  return [part('文件', counts.documents), part('訂閱', counts.subscriptions)].filter(Boolean).join('；') || '沒有變更';
}

function makeScheduler(bundle: Pick<Bundle, 'root' | 'subscriptions' | 'jobs'>, pause: CollectionPause | undefined, noteChange: NoteChange): CollectionScheduler {
  return new CollectionScheduler(bundle.subscriptions.all(), new JsonScheduleStore(bundle.root, noteChange), {
    recordEvent: (entry) => bundle.jobs.recordEvent(entry),
    ...(pause ? { pause } : {}),
  });
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

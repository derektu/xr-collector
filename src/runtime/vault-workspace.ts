import type { NoteChange } from '../core/change-feed.js';
import type { EventType } from '../core/event-catalog.js';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Collector } from '../core/collector.js';
import { CollectorError } from '../core/collector-error.js';
import type {
  ExportSuggestion,
  ImportPreview,
  TransferOperation,
  TransferResult,
  TransferStatus,
} from '../core/vault-types.js';
import type { TranscriptSearch } from '../core/search-types.js';
import type { SourceRegistry } from '../core/source-registry.js';
import type { SubscriptionRecord } from '../core/subscription-types.js';
import { SubscriptionService, SubscriptionServices } from '../subscriptions/subscription-service.js';
import { forwardingPort } from '../jobs/subscription-port.js';
import { CollectionScheduler } from '../subscriptions/scheduler.js';
import { JsonSubscriptionStore, type SubscriptionStore } from '../subscriptions/subscription-store.js';
import { JsonScheduleStore } from '../subscriptions/schedule-store.js';
import { RecentTargets } from '../subscriptions/recent-targets.js';
import { JobManager, type JobLimits, type RetryPolicy } from '../jobs/job-manager.js';
import type { Pacing } from '../pacing/pacing-gate.js';
import type { CollectionPause } from '../core/collection-pause.js';
import type { Connectivity } from '../core/connectivity.js';
import type { SourcePlugin } from '../core/source-contract.js';
import { ActivityLog } from '../activity/activity-log.js';
import { JobStore } from '../jobs/job-store.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { prepareOwnedSearchProjection, searchDatabasePath } from '../search/search-projection.js';
import { MarkdownVault } from '../vault/markdown-vault.js';
import { VaultFileWriter } from '../vault/vault-files.js';
import { deletionId } from '../vault/deleted-documents.js';
import { finishInPlaceImports, type ImportFault } from '../vault/vault-import.js';
import { isWithin, isWorkFolder, recoverImport } from '../vault/transfer-files.js';
import { inspectVaultDirectory, notAVault, readVaultId } from '../vault/vault-directory.js';
import { createNewVault, newVaultFolder } from '../vault/new-vault.js';
import type { StatFs } from '../vault/disk-space.js';
import type { VaultSelection } from '../vault/vault-selection.js';
import { VaultExchange } from '../vault/vault-exchange.js';
import {
  VaultOperationLock, type OperationCompletion, type OperationReporter, type OperationTerminal, type UpdateLease, type VaultAccess,
} from '../vault/operation-lock.js';

interface Bundle {
  root: string;
  /** The way every write of this bundle reaches the Vault's files. */
  files: VaultFileWriter;
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
  /** The source types of every Vault this workspace opens: their documents, subscriptions and jobs. */
  sources: SourceRegistry;
  /** The assembled source plugins every job of this workspace collects through; the types of `sources`, in its order. */
  plugins: readonly SourcePlugin[];
  searchBinary: string;
  /** The search lexicon (`bundledResources().searchLexicon` in the App). */
  searchLexicon: string;
  searchData: string;
  searchPort?: number;
  /** Replaces the search engine; `statusChanged` is called on each change of its status. */
  createSearch?: (root: string, statusChanged: () => void) => Promise<SearchRuntime>;
  /** Device record of collection jobs, which records events into the device activity log; defaults to an in-memory store with an in-memory log. */
  jobStore?: JobStore;
  jobLimits?: Partial<JobLimits>;
  /** The device's request channels, one per pacing group, that the plugins above share. */
  pacing?: readonly Pacing[];
  /** The device's collection pause, followed by the scheduler and jobs of every Vault this workspace opens. */
  pause?: CollectionPause;
  /** The device's network, confirmed by the jobs of every Vault this workspace opens after a request fails for lack of it. */
  connectivity?: Connectivity;
  jobRetry?: Partial<RetryPolicy>;
  /** Starts a timer jobs wait on (a retry's next attempt, a cooldown's end) and returns its cancel function; `setTimeout` by default. */
  jobTimer?: (callback: () => void, ms: number) => () => void;
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
  onAutoPaused?: (vaultId: string, sourceType: string, subscription: SubscriptionRecord) => void | Promise<void>;
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
 * One collection per source type of `sources` with subscriptions, each forwarding to that type's
 * service of whatever Vault `services` returns at call time. A collection names its type without
 * reaching the Vault, so routes can be laid out before one is open.
 */
export function subscriptionCollections(sources: SourceRegistry, services: () => SubscriptionServices): SubscriptionService[] {
  return sources.subscriptionDefinitions.map(({ id: type }) => new Proxy({} as SubscriptionService, {
    get(_object, key) {
      if (key === 'type') return type;
      const service = services().of(type);
      if (!service) throw new Error(`Source type ${type} has no subscription service`);
      const value: unknown = Reflect.get(service, key);
      return typeof value === 'function' ? value.bind(service) : value;
    },
  }));
}

/**
 * The Vault in use and its services: collection, subscriptions, jobs, schedule and search, built
 * for each Vault it opens. Opening or creating another Vault builds the new Vault's services
 * before it stops the old one's; export and import of the Vault in use are its `VaultExchange`.
 * Every Vault operation runs under one operation lock.
 */
export class VaultWorkspace {
  private current!: Bundle;
  private readonly operationLock: VaultOperationLock;
  private readonly exchange: VaultExchange;
  readonly collector = forwarding(() => this.current.collector);
  readonly subscriptions = forwarding(() => this.current.subscriptions);
  readonly jobs = forwarding(() => this.current.jobs);
  readonly schedule = forwarding(() => this.current.schedule);
  readonly search = forwarding<TranscriptSearch>(() => this.current.runtime.search);
  private readonly jobStore: JobStore;
  private readonly holdTimeoutMs: number | undefined;

  private constructor(private readonly options: WorkspaceOptions) {
    this.jobStore = options.jobStore ?? JobStore.memory(options.sources, ActivityLog.memory());
    this.holdTimeoutMs = options.holdTimeoutMs;
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
    this.exchange = new VaultExchange({
      sources: options.sources, profilePath: options.profilePath, exportFolder: options.exportFolder, backupFolder: options.backupFolder,
      createdBy: options.createdBy,
      ...(options.machineName ? { machineName: options.machineName } : {}),
      ...(options.statfs ? { statfs: options.statfs } : {}),
      ...(options.importFaults ? { importFaults: options.importFaults } : {}),
    }, {
      current: () => ({ root: this.current.root, vaultId: this.current.vaultId, files: this.current.files, search: this.current.runtime.search }),
      run: (operation, label, body) => this.run(operation, label, body),
      isLocked: () => this.operationLock.isLocked(),
      setIdle: (message) => this.operationLock.setIdle(message),
      record: (severity, eventType, message) => this.record(severity, eventType, message),
      reloadSchedule: () => this.reloadSchedule(),
      status: () => this.status(),
    });
  }

  private readonly noteChange: NoteChange = (change) => this.options.noteChange?.(change);

  /** Active Vault subscription rows for device-profile notification reconciliation. */
  async notificationSubscriptions(): Promise<Array<{ vaultId: string; sourceType: string; subscription: SubscriptionRecord }>> {
    const rows: Array<{ vaultId: string; sourceType: string; subscription: SubscriptionRecord }> = [];
    for (const service of this.current.subscriptions.all()) {
      for (const subscription of await service.list()) rows.push({ vaultId: this.current.vaultId, sourceType: service.type, subscription });
    }
    return rows;
  }
  activeVaultId(): string { return this.current.vaultId; }

  static async open(options: WorkspaceOptions): Promise<VaultWorkspace> {
    const workspace = new VaultWorkspace(options);
    const root = options.root;
    const selected = await options.selection.read().catch(() => null);
    // The selected Vault and the one being opened are never taken back, whatever the journal says.
    if (!options.pendingImport) await recoverImport(options.profilePath, [selected, root]);
    // An import a stop interrupted after its commit point is finished before anything reads the Vault.
    const finished = await finishInPlaceImports(root, options.sources);
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

  /** See `VaultExchange.exportSuggestion`. */
  exportSuggestion(): ExportSuggestion { return this.exchange.exportSuggestion(); }

  /** See `VaultExchange.exportTo`. */
  exportTo(file?: unknown, overwrite = false): Promise<TransferStatus> { return this.exchange.exportTo(file, overwrite); }

  /** See `VaultExchange.previewImport`. */
  previewImport(file: unknown): Promise<ImportPreview> { return this.exchange.previewImport(file); }

  /** See `VaultExchange.cancelImport`. */
  cancelImport(id: string): void { this.exchange.cancelImport(id); }

  /** See `VaultExchange.applyImport`. */
  applyImport(id: string, mode: unknown): TransferStatus { return this.exchange.applyImport(id, mode); }

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
    const inspection = await inspectVaultDirectory(root, this.options.sources);
    if (inspection.kind !== 'existing') throw new CollectorError('vault_invalid', notAVault(inspection));
    this.exchange.dropPreview();
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
    this.exchange.dropPreview();
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
      await finishInPlaceImports(root, this.options.sources);
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
  private record(severity: 'info' | 'warning' | 'error', eventType: EventType, message: string, vaultPath?: string | null, errorCode?: string): void {
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
    const files = new VaultFileWriter(root, this.options.sources);
    const vault = new MarkdownVault(files);
    // Deletions a stop left unfinished are settled before the search index is compared with the Vault.
    const recovery = await vault.recoverDeletions();
    const databasePath = this.searchPath(root);
    const searchChanged = () => this.noteChange({ kind: 'search' });
    const runtime = this.options.createSearch ? await this.options.createSearch(root, searchChanged) : await startSearchRuntime({
      vault, sources: this.options.sources, binaryPath: this.options.searchBinary, databasePath,
      lexiconPath: this.options.searchLexicon,
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
    for (const plugin of plugins) if (plugin.subscription && plugin.storage) stores[plugin.id] = new JsonSubscriptionStore(files, plugin.id, undefined, this.noteChange);
    // The scheduler is replaced after a merge, so switch reads go through the bundle.
    const autoCollection = () => bundle.schedule.isEnabled();
    // Jobs hold this bundle's own Vault objects, so they never write through to a Vault switched in later.
    const jobs = new JobManager({
      vaultPath: root,
      vaultId,
      store: this.jobStore,
      sources: this.options.sources,
      plugins,
      documents: collector,
      // The subscriptions are built with the jobs they dispatch to, so the port reaches them through the bundle.
      subscriptions: forwardingPort(() => bundle.subscriptions),
      ...(this.options.jobLimits ? { limits: this.options.jobLimits } : {}),
      ...(this.options.jobRetry ? { retry: this.options.jobRetry } : {}),
      ...(this.options.jobTimer ? { setTimer: this.options.jobTimer } : {}),
      ...(this.options.pacing ? { pacing: this.options.pacing } : {}),
      ...(this.options.pause ? { pause: this.options.pause } : {}),
      ...(this.options.connectivity ? { connectivity: this.options.connectivity } : {}),
      recentTarget: (type, url) => recentTargets.get(type, url),
    });
    const subscriptions = new SubscriptionServices(this.options.sources, plugins.filter((plugin) => stores[plugin.id]).map((plugin) =>
      new SubscriptionService(plugin.id, stores[plugin.id]!, jobs, {
        sources: this.options.sources,
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
        eventType: 'document.delete_resumed', message: `已完成上次未完成的刪除：「${record.title}」。`,
        documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title, namesSource: true,
      });
    }
    for (const record of recovery.unresolved) {
      jobs.recordEvent({
        eventType: 'document.delete_unresolved',
        message: `「${record.title}」有刪除紀錄，但文件檔缺少可讀的收集時間；文件維持隱藏，檔案與刪除紀錄都保留。`,
        documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title, namesSource: true,
      });
    }
    for (const record of recovery.cleared) {
      jobs.recordEvent({
        eventType: 'document.recollected', message: `已重新收集「${record.title}」，解除刪除紀錄。`,
        documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title, namesSource: true,
      });
    }
    const partial = { root, files, vaultId, runtime, collector, subscriptions, jobs };
    const bundle: Bundle = { ...partial, schedule: makeScheduler(partial, this.options.pause, this.noteChange) };
    return bundle;
  }

  async close(): Promise<void> {
    await this.operationFinished();
    this.exchange.dropPreview();
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

function makeScheduler(bundle: Pick<Bundle, 'files' | 'subscriptions' | 'jobs'>, pause: CollectionPause | undefined, noteChange: NoteChange): CollectionScheduler {
  return new CollectionScheduler(bundle.subscriptions.all(), new JsonScheduleStore(bundle.files, noteChange), {
    recordEvent: (entry) => bundle.jobs.recordEvent(entry),
    ...(pause ? { pause } : {}),
  });
}

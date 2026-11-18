import type { NoteChange } from '../../shared/api/changes.js';
import {
  openVault,
  VaultOperations,
  type Collector,
  type ImportFault,
  type OpenedVault,
  type StatFs,
  type VaultSelection,
} from '../../domain/vault/index.js';
import type { TranscriptSearch } from '../../shared/api/search-types.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type { SubscriptionRecord } from '../../shared/subscriptions/subscription-types.js';
import {
  SubscriptionService,
  SubscriptionServices,
  CollectionScheduler,
  JsonSubscriptionStore,
  JsonScheduleStore,
  RecentTargets,
  type SchedulerOptions,
  type SubscriptionStore,
} from '../../domain/subscriptions/index.js';
import { forwardingPort, JobManager, JobStore, type JobLimits, type RetryPolicy, type Connectivity } from '../../domain/jobs/index.js';
import type { Pacing } from '../../domain/pacing/index.js';
import type { CollectionPause } from '../../shared/jobs/collection-pause.js';
import type { SourcePlugin } from '../../shared/sources/source-contract.js';
import { ActivityLog } from '../../domain/activity/index.js';
import { startSearchRuntime, prepareOwnedSearchProjection, searchDatabasePath, type SearchRuntime } from '../../domain/search/index.js';

interface Bundle {
  /** The Vault's files, through which every write of this bundle goes. */
  vault: OpenedVault;
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
  /** Starts the timer each Vault's scheduler polls for due subscriptions on; see `SchedulerOptions.setTimer`. */
  scheduleTimer?: SchedulerOptions['setTimer'];
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
 * before it stops the old one's. Every Vault operation (export, import, creating a new Vault and
 * opening another) runs under the one operation lock of its `VaultOperations`.
 */
export class VaultWorkspace {
  private current!: Bundle;
  /**
   * Every operation on the Vault in use (export, import, creating a new Vault, opening another) and
   * the request leases and status that go with them; transport and the runtime reach them here.
   */
  readonly operations: VaultOperations;
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
    this.operations = new VaultOperations({
      sources: options.sources, selection: options.selection, profilePath: options.profilePath,
      exportFolder: options.exportFolder, backupFolder: options.backupFolder, createdBy: options.createdBy,
      noteChange: this.noteChange,
      ...(options.machineName ? { machineName: options.machineName } : {}),
      ...(options.statfs ? { statfs: options.statfs } : {}),
      ...(options.importFaults ? { importFaults: options.importFaults } : {}),
      ...(options.fixedLocation ? { fixedLocation: options.fixedLocation } : {}),
    }, {
      current: () => ({ vault: this.current.vault, search: this.current.runtime.search }),
      hold: (signal) => this.current.jobs.hold(this.holdTimeoutMs, signal),
      idle: () => this.current.schedule.idle(),
      suspend: (value) => this.current.schedule.setSuspended(value),
      event: (entry) => this.jobStore.event(entry),
      flushJobs: () => this.jobStore.flush(),
      reloadSchedule: () => this.reloadSchedule(),
      prepare: (root) => this.prepare(root),
    });
  }

  private readonly noteChange: NoteChange = (change) => this.options.noteChange?.(change);

  /** Active Vault subscription rows for device-profile notification reconciliation. */
  async notificationSubscriptions(): Promise<Array<{ vaultId: string; sourceType: string; subscription: SubscriptionRecord }>> {
    const rows: Array<{ vaultId: string; sourceType: string; subscription: SubscriptionRecord }> = [];
    for (const service of this.current.subscriptions.all()) {
      for (const subscription of await service.list()) rows.push({ vaultId: this.current.vault.vaultId, sourceType: service.type, subscription });
    }
    return rows;
  }
  activeVaultId(): string { return this.current.vault.vaultId; }

  static async open(options: WorkspaceOptions): Promise<VaultWorkspace> {
    const workspace = new VaultWorkspace(options);
    const root = options.root;
    const finished = await workspace.operations.recover(root, options.pendingImport);
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

  /** Which activity belongs to the active Vault: its ID and its path. */
  activityScope(): { vaultPath: string; vaultId: string } {
    return { vaultPath: this.current.vault.root, vaultId: this.current.vault.vaultId };
  }

  /**
   * Builds the services of the Vault at `root` and indexes it for a switch; the Vault in use is not
   * touched until the returned Vault is activated. A Vault that cannot be prepared has its services
   * stopped again.
   */
  private async prepare(root: string) {
    const candidate = await this.makeBundle(root);
    const discard = async () => {
      await step('Candidate schedule shutdown failed', () => candidate.schedule.close());
      await step('Candidate jobs shutdown failed', () => candidate.jobs.close());
      await step('Candidate search shutdown failed', () => candidate.runtime.close());
    };
    try {
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
    } catch (error) {
      await discard();
      throw error;
    }
    return {
      activate: () => {
        const previous = this.current;
        this.current = candidate;
        return { root: previous.vault.root, settle: (reason: string) => this.switchFrom(previous, reason) };
      },
      discard,
    };
  }

  /**
   * Settles a committed switch: stops the previous Vault's scheduler, jobs and search, then continues
   * the unfinished jobs of the Vault now in use and starts its scheduler. The previous jobs are
   * recorded as interrupted with `reason`. Each step that fails is logged and the switch still
   * completes, because the selection already names the new Vault.
   */
  private async switchFrom(previous: Bundle, reason: string): Promise<{ interruptedJobs: number; resumedJobs: number }> {
    const interruptedJobs = previous.jobs.unfinishedCount();
    await step('Previous schedule shutdown failed', () => previous.schedule.close());
    await step('Previous jobs shutdown failed', () => previous.jobs.close(reason, 'vault_switch'));
    await step('Previous search shutdown failed', () => previous.runtime.close());
    await step('Resuming jobs failed', () => this.current.jobs.resume());
    await step('Schedule start failed', () => this.current.schedule.start());
    return { interruptedJobs, resumedJobs: this.current.jobs.unfinishedCount() };
  }

  /** Restarts the schedule after an import; imported subscriptions arrive without a next check time and get one first. */
  private async reloadSchedule(): Promise<void> {
    await this.current.schedule.close();
    for (const service of this.current.subscriptions.all()) await service.planChecks({ overdue: false });
    this.current.schedule = makeScheduler(this.current, this.options, this.noteChange);
    this.current.schedule.setSuspended(true);
    await this.current.schedule.start();
  }

  private async makeBundle(root: string, port?: number): Promise<Bundle> {
    const vault = await openVault(root, this.options.sources);
    const searchChanged = () => this.noteChange({ kind: 'search' });
    const runtime = this.options.createSearch ? await this.options.createSearch(root, searchChanged) : await startSearchRuntime({
      vault: vault.documents, sources: this.options.sources, binaryPath: this.options.searchBinary,
      // Each Vault path gets its own rebuildable search database on this device.
      databasePath: searchDatabasePath(this.options.searchData, root),
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
    const collector = vault.collector(runtime.search, { recordEvent: (entry) => jobs.recordEvent(entry), noteChange: this.noteChange });
    const plugins = this.options.plugins;
    const recentTargets = new RecentTargets();
    const stores: Record<string, SubscriptionStore> = {};
    for (const plugin of plugins) if (plugin.subscription && plugin.storage) stores[plugin.id] = new JsonSubscriptionStore(vault.files, plugin.id, undefined, this.noteChange);
    // The scheduler is replaced after a merge, so switch reads go through the bundle.
    const autoCollection = () => bundle.schedule.isEnabled();
    // Jobs hold this bundle's own Vault objects, so they never write through to a Vault switched in later.
    const jobs = new JobManager({
      vaultPath: root,
      vaultId: vault.vaultId,
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
        ...(this.options.onAutoPaused ? { onAutoPaused: (record) => this.options.onAutoPaused!(vault.vaultId, plugin.id, record) } : {}),
      })));
    for (const event of vault.recoveryEvents) jobs.recordEvent(event);
    const partial = { vault, runtime, collector, subscriptions, jobs };
    const bundle: Bundle = { ...partial, schedule: makeScheduler(partial, this.options, this.noteChange) };
    return bundle;
  }

  async close(): Promise<void> {
    await this.operations.finished();
    this.operations.dropPreview();
    const drained = await Promise.allSettled([
      this.current.schedule.close(),
      this.current.jobs.close(),
    ]);
    const search = await Promise.allSettled([this.current.runtime.close()]);
    const failed = [...drained, ...search].find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Runs one step of stopping a Vault's services; a failure is logged and the next step goes on. */
async function step(label: string, work: () => Promise<unknown>): Promise<void> {
  try { await work(); } catch (error) { console.error(label, error); }
}

function makeScheduler(
  bundle: Pick<Bundle, 'vault' | 'subscriptions' | 'jobs'>, { pause, scheduleTimer }: Pick<WorkspaceOptions, 'pause' | 'scheduleTimer'>, noteChange: NoteChange,
): CollectionScheduler {
  return new CollectionScheduler(bundle.subscriptions.all(), new JsonScheduleStore(bundle.vault.files, noteChange), {
    recordEvent: (entry) => bundle.jobs.recordEvent(entry),
    ...(pause ? { pause } : {}),
    ...(scheduleTimer ? { setTimer: scheduleTimer } : {}),
  });
}

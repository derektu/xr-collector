import type { NoteChange } from '../../shared/api/changes.js';
import {
  openVault,
  VaultOperations,
  type Collector,
  type OpenedVault,
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
} from '../../domain/subscriptions/index.js';
import { forwardingPort, JobManager, JobStore, type JobLimits, type RetryPolicy, type Connectivity } from '../../domain/jobs/index.js';
import type { Pacing } from '../../domain/pacing/index.js';
import type { CollectionPause } from '../../shared/jobs/collection-pause.js';
import type { SourcePlugin } from '../../shared/sources/source-contract.js';
import type { Timers } from '../../shared/lib/time.js';
import { ActivityLog } from '../../domain/activity/index.js';
import { startSearchRuntime, type SearchRuntime } from '../../domain/search/index.js';
import type { LogWriter } from '../../shared/log/log-types.js';

interface Bundle {
  vault: OpenedVault;
  collector: Collector;
  subscriptions: SubscriptionServices;
  jobs: JobManager;
  schedule: CollectionScheduler;
  runtime: SearchRuntime;
}
export interface WorkspaceOptions {
  root: string;
  selection: VaultSelection;
  exportFolder: string;
  backupFolder: string;
  machineName?: string;
  createdBy: string;
  sources: SourceRegistry;
  log: LogWriter;
  plugins: readonly SourcePlugin[];
  searchBinary: string;
  searchLexicon: string;
  searchData: string;
  searchPort?: number;
  createSearch?: (root: string, statusChanged: () => void) => Promise<SearchRuntime>;
  jobStore?: JobStore;
  jobLimits?: Partial<JobLimits>;
  pacing?: readonly Pacing[];
  pause?: CollectionPause;
  connectivity?: Connectivity;
  jobRetry?: Partial<RetryPolicy>;
  jobTimers?: Timers;
  scheduleTimer?: SchedulerOptions['setTimer'];
  fixedLocation?: boolean;
  noteChange?: NoteChange;
  onAutoPaused?: (vaultId: string, sourceType: string, subscription: SubscriptionRecord) => void | Promise<void>;
}

export function forwarding<T extends object>(target: () => T): T {
  return new Proxy({} as T, {
    get(_object, key) {
      const object = target();
      const value: unknown = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

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

export class VaultWorkspace {
  private current!: Bundle;
  readonly operations: VaultOperations;
  readonly collector = forwarding(() => this.current.collector);
  readonly subscriptions = forwarding(() => this.current.subscriptions);
  readonly jobs = forwarding(() => this.current.jobs);
  readonly schedule = forwarding(() => this.current.schedule);
  readonly search = forwarding<TranscriptSearch>(() => this.current.runtime.search);
  private readonly jobStore: JobStore;

  private constructor(private readonly options: WorkspaceOptions) {
    this.jobStore = options.jobStore ?? JobStore.memory(options.sources, ActivityLog.memory({ log: options.log }), options.log);
    this.operations = new VaultOperations({
      sources: options.sources, selection: options.selection,
      exportFolder: options.exportFolder, backupFolder: options.backupFolder, createdBy: options.createdBy,
      noteChange: this.noteChange, log: options.log,
      ...(options.machineName ? { machineName: options.machineName } : {}),
      ...(options.fixedLocation ? { fixedLocation: options.fixedLocation } : {}),
    }, {
      current: () => ({ vault: this.current.vault, search: this.current.runtime.search }),
      hold: () => this.current.jobs.hold(),
      idle: () => this.current.schedule.idle(),
      suspend: (value) => this.current.schedule.setSuspended(value),
      event: (entry) => this.jobStore.event(entry),
      flushJobs: () => this.jobStore.flush(),
      reloadSchedule: () => this.reloadSchedule(),
      prepare: (root) => this.prepare(root),
    });
  }

  private readonly noteChange: NoteChange = (change) => this.options.noteChange?.(change);

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
    workspace.current = await workspace.makeBundle(options.root, options.searchPort);
    try {
      await workspace.current.jobs.resume();
      await workspace.current.schedule.start();
    } catch (error) {
      await workspace.current.jobs.close().catch(() => undefined);
      await workspace.current.runtime.close().catch(() => undefined);
      throw error;
    }
    return workspace;
  }

  activityScope(): { vaultPath: string; vaultId: string } {
    return { vaultPath: this.current.vault.root, vaultId: this.current.vault.vaultId };
  }

  private async prepare(root: string) {
    const candidate = await this.makeBundle(root);
    const discard = async () => {
      await this.step('Candidate schedule shutdown failed', () => candidate.schedule.close());
      await this.step('Candidate jobs shutdown failed', () => candidate.jobs.close());
      await this.step('Candidate search shutdown failed', () => candidate.runtime.close());
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

  private async switchFrom(previous: Bundle, reason: string): Promise<{ interruptedJobs: number; resumedJobs: number }> {
    const interruptedJobs = previous.jobs.unfinishedCount();
    await this.step('Previous schedule shutdown failed', () => previous.schedule.close());
    await this.step('Previous jobs shutdown failed', () => previous.jobs.close(reason, 'vault_switch'));
    await this.step('Previous search shutdown failed', () => previous.runtime.close());
    await this.step('Resuming jobs failed', () => this.current.jobs.resume());
    await this.step('Schedule start failed', () => this.current.schedule.start());
    return { interruptedJobs, resumedJobs: this.current.jobs.unfinishedCount() };
  }

  private async reloadSchedule(): Promise<void> {
    await this.current.schedule.close();
    for (const service of this.current.subscriptions.all()) await service.planChecks({ overdue: false });
    this.current.schedule = makeScheduler(this.current, this.options, this.noteChange);
    this.current.schedule.setSuspended(true);
    await this.current.schedule.start();
  }

  private async makeBundle(root: string, port?: number): Promise<Bundle> {
    const vault = await openVault(root, this.options.sources, this.options.log);
    const searchChanged = () => this.noteChange({ kind: 'search' });
    const runtime = this.options.createSearch ? await this.options.createSearch(root, searchChanged) : await startSearchRuntime({
      vault: vault.documents, sources: this.options.sources, binaryPath: this.options.searchBinary,
      lexiconPath: this.options.searchLexicon, searchData: this.options.searchData, vaultRoot: root, log: this.options.log,
      ...(port ? { port } : {}),
      statusChanged: searchChanged,
    });
    const collector = vault.collector(runtime.search, { recordEvent: (entry) => jobs.recordEvent(entry), noteChange: this.noteChange });
    const plugins = this.options.plugins;
    const recentTargets = new RecentTargets();
    const subscribed = plugins.filter((plugin) => plugin.subscription && plugin.storage)
      .map((plugin) => [plugin, new JsonSubscriptionStore(vault.files, plugin.id, undefined, this.noteChange)] as const);
    const autoCollection = () => bundle.schedule.isEnabled();
    const jobs = new JobManager({
      vaultPath: root,
      vaultId: vault.vaultId,
      store: this.jobStore,
      sources: this.options.sources,
      plugins,
      documents: collector,
      log: this.options.log,
      subscriptions: forwardingPort(() => bundle.subscriptions),
      ...(this.options.jobLimits ? { limits: this.options.jobLimits } : {}),
      ...(this.options.jobRetry ? { retry: this.options.jobRetry } : {}),
      ...(this.options.jobTimers ? { timers: this.options.jobTimers } : {}),
      ...(this.options.pacing ? { pacing: this.options.pacing } : {}),
      ...(this.options.pause ? { pause: this.options.pause } : {}),
      ...(this.options.connectivity ? { connectivity: this.options.connectivity } : {}),
      recentTarget: (type, url) => recentTargets.get(type, url),
    });
    const onAutoPaused = this.options.onAutoPaused;
    const subscriptions = new SubscriptionServices(this.options.sources, subscribed.map(([plugin, store]) => {
      const login = plugin.login;
      return new SubscriptionService(plugin.id, store, jobs, {
        sources: this.options.sources,
        log: this.options.log,
        autoCollection,
        resolveTarget: async (url, signal) => {
          const target = await plugin.resolveTarget!(url, { priority: 'interactive', signal });
          recentTargets.remember(plugin.id, url, target);
          try {
            const targetInput = plugin.classify(target.url);
            if (targetInput.kind === 'subscription') recentTargets.remember(plugin.id, targetInput.url, target);
          } catch { }
          return target;
        },
        documents: () => collector.list(),
        deleteDocument: (id) => collector.delete(id),
        ...(login ? { loginRequired: () => login.status() === 'required' } : {}),
        ...(onAutoPaused ? { onAutoPaused: (record) => onAutoPaused(vault.vaultId, plugin.id, record) } : {}),
      });
    }));
    const partial = { vault, runtime, collector, subscriptions, jobs };
    const bundle: Bundle = { ...partial, schedule: makeScheduler(partial, this.options, this.noteChange) };
    return bundle;
  }

  private async step(label: string, work: () => Promise<unknown>): Promise<void> {
    try { await work(); } catch (error) { this.options.log.write({ level: 'error', source: 'runtime', message: label, error }); }
  }

  async close(): Promise<void> {
    await this.step('Data exchange shutdown failed', () => this.operations.finished());
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

function makeScheduler(
  bundle: Pick<Bundle, 'vault' | 'subscriptions' | 'jobs'>, { pause, scheduleTimer, log }: Pick<WorkspaceOptions, 'pause' | 'scheduleTimer' | 'log'>, noteChange: NoteChange,
): CollectionScheduler {
  return new CollectionScheduler(bundle.subscriptions.all(), new JsonScheduleStore(bundle.vault.files, noteChange), {
    log,
    recordEvent: (entry) => bundle.jobs.recordEvent(entry),
    ...(pause ? { pause } : {}),
    ...(scheduleTimer ? { setTimer: scheduleTimer } : {}),
  });
}

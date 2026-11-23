import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { BuildInfo } from '../../shared/api/update-types.js';
import type { TranscriptSearch } from '../../shared/api/search-types.js';
import type {
  NewVaultCheck,
  VaultSetup,
  VaultSetupRequest,
  VaultSetupResult,
  VaultSetupStatus,
  TransferStatus,
} from '../../shared/vault/vault-types.js';
import type { ActivityAccess } from '../../shared/activity/activity-types.js';
import { loadBuildInfo, type UpdateAccess } from '../../domain/updates/index.js';
import { ChangeFeed } from './change-feed.js';
import { CollectionPause } from '../../shared/jobs/collection-pause.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type { LoginStartupAccess } from '../../shared/api/login-startup.js';
import { Connectivity, type ConnectivityOptions, type JobManager } from '../../domain/jobs/index.js';
import { openJobRecords, type JobRecords } from './job-records.js';
import { openAgentConnection, type AgentConnectionService } from './agent-connection.js';
import { DEVELOPMENT_AGENT_PORT } from './agent-connection-defaults.js';
import { DeviceVaults, type Collector, type UpdateLease, type VaultOperations } from '../../domain/vault/index.js';
import { forwarding, subscriptionCollections, VaultWorkspace, type WorkspaceOptions } from './vault-workspace.js';
import type { Pacing } from '../../domain/pacing/index.js';
import type { CollectionScheduler, SubscriptionService } from '../../domain/subscriptions/index.js';
import { NotificationCenter, type SystemNotificationAdapter } from '../../domain/notifications/index.js';
import type { EventType } from '../../shared/activity/event-catalog.js';
import type { CollectorRuntimeState, CollectorRuntimeStatus, NotificationAccess } from '../../shared/api/device-types.js';


export type VaultServiceOptions = Omit<WorkspaceOptions, 'root' | 'selection' | 'createdBy' | 'pause' | 'connectivity' | 'sources'>;

export interface CollectorRuntimeOptions {
  buildInfo?: BuildInfo;
  profilePath: string;
  /**
   * The source types of this process, which the Vault, the jobs and both listeners read; with a
   * workspace, its plugins are these types in this order.
   */
  sources: SourceRegistry;
  /** Null runs only health and Agent identity, without any Vault services. */
  workspace: VaultServiceOptions | null;
  /** How the device's network is confirmed; the internet probe and its intervals by default. */
  connectivity?: Omit<ConnectivityOptions, 'pause'>;
  /** The device's collection pause, when the caller sets reasons on it before the runtime starts; a new one otherwise. */
  pause?: CollectionPause;
  /** Uses this Vault instead of the device selection; an empty directory becomes a new Vault. */
  explicitVaultPath?: string;
  /** Folder a new Vault goes in while none is active; the Documents folder by default. */
  newVaultLocation?: string;
  /** Application name and version recorded in Vaults this runtime creates. */
  createdBy?: string;
  agentSettingsFile: string;
  skillPath: string;
  agentPort?: number;
  /** Packaged desktop login-startup service; absent servers report the setting unavailable. */
  loginStartup?: LoginStartupAccess;
  /** Records a packaged OS login launch in the device activity log. */
  startedAtLogin?: boolean;
  /** Device-level software update state shared by UI and authorized Agent APIs. */
  updates?: UpdateAccess;
  systemNotifications?: SystemNotificationAdapter;
}

/**
 * What the runtime serves through its listeners. The Vault services forward to whichever Vault is
 * open and are absent when the runtime runs without Vault services.
 */
export interface RuntimeServices {
  sources: SourceRegistry;
  buildInfo: BuildInfo;
  changes: ChangeFeed;
  connectivity: Connectivity;
  notifications: NotificationAccess;
  loginStartup?: LoginStartupAccess;
  updates?: UpdateAccess;
  collector?: Collector;
  jobs?: JobManager;
  transfer?: VaultOperations;
  subscriptions?: SubscriptionService[];
  schedule?: CollectionScheduler;
  search?: TranscriptSearch;
  pacing?: readonly Pacing[];
  activity?: ActivityAccess;
  runtimeStatus: () => CollectorRuntimeStatus;
  /** Why business routes are unavailable, or null once a Vault is open. */
  notReady: () => string | null;
  vaultSetup: VaultSetup;
  /** The Agent credential, opened before any Vault; a listener that serves Agents attaches to it. */
  agentConnection: AgentConnectionService;
}

/** The listeners a runtime serves through; the runtime closes them before its Vault. */
export interface RuntimeListeners {
  close(): Promise<void>;
}

export type StartListeners<L extends RuntimeListeners> = (services: RuntimeServices) => Promise<L>;

const NOT_SET_MESSAGE = '尚未設定 Vault。請在 UI Onboarding 選擇或建立 Vault，或呼叫 POST /api/vault/setup。';

/**
 * Owns the one workspace, scheduler and Agent credential of a process, and the listeners it serves
 * them through. Starting opens the Agent credential, then the Vault, then the listeners; closing
 * stops the listeners, then the Vault, then the job records.
 */
export class CollectorRuntime<L extends RuntimeListeners = RuntimeListeners> {
  readonly instanceId: string;
  readonly profilePath: string;
  readonly listeners: L;
  readonly agentConnection: AgentConnectionService;
  /** The device's collection pause, followed by the scheduler and jobs of whichever Vault is open. */
  readonly pause: CollectionPause;
  readonly connectivity: Connectivity;
  readonly notifications: NotificationCenter;
  readonly changes: ChangeFeed;
  private workspaceValue: VaultWorkspace | null;
  private failure: { path: string; reason: string } | null;
  private stateValue: CollectorRuntimeState;
  private message: string;
  private settingUp = false;
  private preparingUpdate = false;
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly options: CollectorRuntimeOptions,
    private readonly services: WorkspaceServices | null,
    private readonly vaults: DeviceVaults,
    instanceId: string,
    initial: Opening,
    agentConnection: AgentConnectionService,
    listeners: L,
    private readonly records: JobRecords | null,
    pause: CollectionPause,
    connectivity: Connectivity,
    notifications: NotificationCenter,
    changes: ChangeFeed,
    private readonly stopFollowing: () => void,
  ) {
    this.changes = changes;
    this.pause = pause;
    this.connectivity = connectivity;
    this.notifications = notifications;
    this.instanceId = instanceId;
    this.profilePath = path.resolve(options.profilePath);
    this.workspaceValue = initial.workspace;
    this.failure = initial.failure;
    this.agentConnection = agentConnection;
    this.listeners = listeners;
    this.stateValue = initial.workspace ? 'ready' : 'not_ready';
    this.message = initial.workspace ? '服務已就緒。' : initial.message;
  }

  activeVaultId(): string | null { return this.workspaceValue?.activeVaultId() ?? null; }

  /** The export or import of the Vault in use, as `GET /api/vault/status` answers it; null while no Vault is in use. */
  transferStatus(): TransferStatus | null { return this.workspaceValue?.operations.status() ?? null; }

  /** Records a device-wide desktop event; global events stay visible with any Vault selected. */
  recordDeviceEvent(severity: 'info' | 'warning' | 'error', eventType: EventType, message: string, errorCode?: string): void {
    recordDeviceEvent(this.records, severity, eventType, message, errorCode);
  }

  /**
   * Opens the Agent credential and the Vault, then starts the listeners with `listen`. Throws before
   * opening anything when `workspace.plugins` are not the types of `sources`.
   */
  static async start<L extends RuntimeListeners>(options: CollectorRuntimeOptions, listen: StartListeners<L>): Promise<CollectorRuntime<L>> {
    if (options.workspace) options.sources.checkPlugins(options.workspace.plugins);
    const sources = options.sources;
    const instanceId = randomUUID();
    const vaults = new DeviceVaults({
      profilePath: options.profilePath, sources, createdBy: options.createdBy ?? 'XR Collector',
    });
    let initial: Opening = { workspace: null, failure: null, message: NOT_SET_MESSAGE };
    let agentConnection: AgentConnectionService | null = null;
    let runtime: CollectorRuntime<L> | null = null;
    const currentWorkspace = (): VaultWorkspace | null => runtime ? runtime.workspaceValue : initial.workspace;
    const current = (): VaultWorkspace => {
      const workspace = currentWorkspace();
      if (!workspace) throw new CollectorError('vault_not_ready', runtime?.message ?? initial.message);
      return workspace;
    };
    const runtimeStatus = (): CollectorRuntimeStatus => runtime?.status() ?? {
      state: 'starting', instanceId, profilePath: path.resolve(options.profilePath),
      vaultPath: initial.workspace?.operations.status().vaultPath ?? null, message: '服務啟動中。',
    };
    const changes = new ChangeFeed();
    const records = options.workspace ? await openJobRecords(path.join(options.profilePath, 'jobs'), sources, { noteChange: changes.note }) : null;
    const deviceEvent = (severity: 'info' | 'warning' | 'error', eventType: EventType, message: string, errorCode?: string) =>
      recordDeviceEvent(records, severity, eventType, message, errorCode);
    if (options.startedAtLogin) deviceEvent('info', 'device.login_startup_launched', 'XR Collector 由電腦登入自動啟動，並在背景執行。');
    const pause = options.pause ?? new CollectionPause();
    const connectivity = new Connectivity({ ...options.connectivity, pause });
    const notifications = await NotificationCenter.open(options.profilePath, options.systemNotifications);
    const following = [
      pause.subscribe(() => changes.note({ kind: 'connectivity' })),
      ...(options.workspace?.pacing ?? []).map((gate) => gate.subscribe(() => changes.note({ kind: 'pacing', group: gate.group }))),
      options.updates?.subscribe?.(() => changes.note({ kind: 'update' })) ?? (() => undefined),
    ];
    const stopFollowing = () => { for (const stop of following) stop(); };
    const workspaceServices: WorkspaceServices | null = options.workspace && records ? {
      ...options.workspace, sources, jobStore: records.jobs, pause, connectivity, noteChange: changes.note,
      onAutoPaused: async (vaultId, sourceType, record) => {
        await notifications.recordAutoPause(vaultId, sourceType, record);
        changes.note({ kind: 'notifications' });
      },
    } : null;
    const activity: ActivityAccess | undefined = records ? {
      query: (query) => records.views.query(query, currentWorkspace()?.activityScope() ?? { vaultPath: null }),
      summary: (query) => records.views.summary(query, currentWorkspace()?.activityScope() ?? { vaultPath: null }),
      group: (groupId, limit, cursor, severity) => records.views.group(groupId, currentWorkspace()?.activityScope() ?? { vaultPath: null }, limit, cursor, severity),
      health: () => records.views.health(),
    } : undefined;
    const services = options.workspace ? {
      collector: forwarding(() => current().collector),
      jobs: forwarding(() => current().jobs),
      transfer: forwarding(() => current().operations),
      subscriptions: subscriptionCollections(sources, () => current().subscriptions),
      schedule: forwarding(() => current().schedule),
      search: forwarding<TranscriptSearch>(() => current().search),
      ...(options.workspace.pacing ? { pacing: options.workspace.pacing } : {}),
    } : {};
    const startupService = options.loginStartup;
    const loginStartup: LoginStartupAccess | undefined = startupService ? {
      status: () => startupService.status(),
      update: async (enabled) => {
        try {
          const status = await startupService.update(enabled);
          deviceEvent('info', enabled ? 'device.login_startup_enabled' : 'device.login_startup_disabled',
            enabled ? '已開啟登入電腦時自動啟動。' : '已關閉登入電腦時自動啟動。');
          return status;
        } catch (error) {
          const code = error instanceof CollectorError ? error.code : 'login_startup_failed';
          deviceEvent(code === 'login_startup_requires_approval' ? 'warning' : 'error',
            'device.login_startup_failed', error instanceof Error ? error.message : '登入自啟設定失敗。', code);
          throw error;
        }
      },
    } : undefined;
    const notificationState = async () => notifications.view(await currentWorkspace()?.notificationSubscriptions() ?? []);
    const notificationAccess: NotificationAccess = {
      read: notificationState,
      update: async (enabled: boolean) => { await notifications.update(enabled); changes.note({ kind: 'notifications' }); return notificationState(); },
    };
    const shared = { ...services, sources, changes, notifications: notificationAccess, buildInfo: options.buildInfo ?? await loadBuildInfo(), connectivity,
      ...(loginStartup ? { loginStartup } : {}), ...(options.updates ? { updates: options.updates } : {}) };
    const vaultSetup: VaultSetup = {
      status: () => runtime!.vaultStatus(),
      inspect: (vaultPath) => vaults.inspect(vaultPath),
      checkNew: (location, name) => runtime!.checkNew(location, name),
      describePackage: (file) => vaults.describePackage(file),
      setup: (request) => runtime!.setup(request),
    };
    const notReady = () => runtime ? (runtime.workspaceValue ? null : runtime.message) : initial.message;
    const agentSettings = {
      preferredPort: options.agentPort ?? DEVELOPMENT_AGENT_PORT, settingsFile: options.agentSettingsFile, skillPath: options.skillPath, event: deviceEvent,
    };
    try {
      agentConnection = await openAgentConnection(agentSettings);
      if (workspaceServices) initial = await CollectorRuntime.openInitial(options, workspaceServices, vaults);
      const listeners = await listen({
        ...shared,
        ...(activity ? { activity } : {}),
        runtimeStatus, notReady, vaultSetup, agentConnection,
      });
      runtime = new CollectorRuntime(options, workspaceServices, vaults, instanceId, initial, agentConnection, listeners, records, pause, connectivity,
        notifications, changes, stopFollowing);
      return runtime;
    } catch (error) {
      await agentConnection?.close().catch(() => undefined);
      await initial.workspace?.close().catch(() => undefined);
      await records?.close().catch(() => undefined);
      connectivity.close();
      stopFollowing();
      throw error;
    }
  }

  private static async openInitial(
    options: CollectorRuntimeOptions,
    services: WorkspaceServices,
    vaults: DeviceVaults,
  ): Promise<Opening> {
    const initial = await vaults.initial(options.explicitVaultPath);
    if (initial.kind === 'unset') return { workspace: null, failure: null, message: NOT_SET_MESSAGE };
    if (initial.kind === 'unusable') {
      return {
        workspace: null, failure: { path: initial.path, reason: initial.reason },
        message: `目前選擇的 Vault 無法使用：${initial.reason}請在 UI Onboarding 重新選擇 Vault。`,
      };
    }
    return {
      workspace: await VaultWorkspace.open({
        ...services, root: initial.root, selection: vaults.selection, createdBy: options.createdBy ?? 'XR Collector',
        fixedLocation: Boolean(options.explicitVaultPath),
      }), failure: null, message: '',
    };
  }

  checkNew(location: unknown, name: unknown): Promise<NewVaultCheck> {
    return this.vaults.checkNew(location, name);
  }

  vaultStatus(): VaultSetupStatus {
    return {
      state: this.workspaceValue ? 'ready' : 'not_ready',
      vaultPath: this.workspaceValue?.operations.status().vaultPath ?? null,
      newVault: {
        location: this.workspaceValue ? path.dirname(this.workspaceValue.operations.status().vaultPath)
          : this.options.newVaultLocation ?? path.join(homedir(), 'Documents'),
        name: this.vaults.defaultName,
      },
      failure: this.workspaceValue ? null : this.failure,
    };
  }

  /**
   * Creates, opens or imports a Vault while Not Ready, then starts its services and remembers the
   * location. A new Vault, empty or imported, is the new folder `name` in `location`; an import
   * fills it from the export file `packagePath` and keeps the automatic collection switch the
   * export file holds.
   */
  async setup(request: VaultSetupRequest): Promise<VaultSetupResult> {
    if (!this.services) throw new CollectorError('vault_not_ready', '此執行環境沒有提供 Vault 服務。');
    if (this.closing) throw new CollectorError('vault_busy', '服務正在停止。');
    if (this.workspaceValue) {
      throw new CollectorError('vault_already_set', '已經有使用中的知識庫。要建立或開啟其他知識庫，請使用 POST /api/vault/create 或 POST /api/vault/open。');
    }
    if (this.settingUp) throw new CollectorError('vault_busy', '正在設定知識庫，請等待目前的操作完成。');
    if (this.preparingUpdate) throw new CollectorError('update_busy', '正在準備安裝更新，暫時不能變更知識庫。');
    this.settingUp = true;
    try {
      const services = this.services;
      const { workspace, documentCount } = await this.vaults.setUp(request, (root) => VaultWorkspace.open({
        ...services, root, selection: this.vaults.selection, createdBy: this.options.createdBy ?? 'XR Collector',
      }));
      this.workspaceValue = workspace;
      this.failure = null;
      this.stateValue = 'ready';
      this.message = '服務已就緒。';
      this.changes.note({ kind: 'vault', scope: 'contents' });
      return { vault: this.vaultStatus(), documentCount };
    } finally {
      this.settingUp = false;
    }
  }

  /** Device-level update exclusion, including the no-Vault state. */
  async prepareUpdate(signal: AbortSignal): Promise<UpdateLease> {
    if (signal.aborted) throw signal.reason;
    if (this.closing || this.preparingUpdate) throw new CollectorError('update_busy', '更新或服務停止已經進行中。');
    if (this.settingUp) throw new CollectorError('vault_busy', '正在設定知識庫，請等它完成後再更新。');
    this.preparingUpdate = true;
    let workspaceLease: UpdateLease | null = null;
    try {
      workspaceLease = this.workspaceValue ? await this.workspaceValue.operations.prepareUpdate(signal) : null;
      if (signal.aborted || this.closing) throw signal.aborted ? signal.reason : new CollectorError('update_busy', '服務正在停止。');
    }
    catch (error) { workspaceLease?.cancel(); this.preparingUpdate = false; throw error; }
    let finished = false;
    return {
      cancel: () => {
        if (finished) return; finished = true; workspaceLease?.cancel(); this.preparingUpdate = false;
      },
      transferToShutdown: () => {
        if (finished) throw new CollectorError('update_busy', '更新等待已經結束。');
        if (signal.aborted || this.closing) {
          workspaceLease?.cancel(); this.preparingUpdate = false;
          throw signal.aborted ? signal.reason : new CollectorError('update_busy', '服務正在停止。');
        }
        try { workspaceLease?.transferToShutdown(); }
        catch (error) { workspaceLease?.cancel(); this.preparingUpdate = false; throw error; }
        finished = true;
      },
    };
  }

  status(): CollectorRuntimeStatus {
    return {
      state: this.stateValue,
      instanceId: this.instanceId,
      profilePath: this.profilePath,
      vaultPath: this.workspaceValue?.operations.status().vaultPath ?? null,
      message: this.message,
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stateValue = 'stopping';
    this.message = '服務停止中，正在完成已接受的操作。';
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.connectivity.close();
    this.stopFollowing();
    const listeners = await Promise.allSettled([this.listeners.close()]);
    const workspace = this.workspaceValue ? await Promise.allSettled([this.workspaceValue.close()]) : [];
    const store = this.records ? await Promise.allSettled([this.records.close()]) : [];
    const failed = [...listeners, ...workspace, ...store]
      .find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (!failed) {
      this.stateValue = 'stopped';
      this.message = '服務已停止。';
      return;
    }
    this.stateValue = 'unavailable';
    this.message = failed.reason instanceof Error ? failed.reason.message : '服務停止失敗。';
    throw failed.reason;
  }
}

type WorkspaceServices = VaultServiceOptions & Required<Pick<WorkspaceOptions, 'sources' | 'jobStore' | 'pause' | 'connectivity'>>;

function recordDeviceEvent(records: JobRecords | null, severity: 'info' | 'warning' | 'error', eventType: EventType, message: string, errorCode?: string): void {
  records?.activity.event({ severity, eventType, message, vaultPath: null, jobId: null, ...(errorCode ? { errorCode } : {}) });
}

interface Opening {
  workspace: VaultWorkspace | null;
  failure: { path: string; reason: string } | null;
  message: string;
}

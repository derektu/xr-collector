import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CollectorError,
  type TranscriptSearch,
  type VaultInspection,
  type VaultSetupAction,
  type VaultSetupResult,
  type VaultSetupStatus,
} from '../core/types.js';
import { CollectionPause } from '../core/collection-pause.js';
import type { LoginStartupAccess } from '../core/login-startup.js';
import { Connectivity, type ConnectivityOptions } from '../core/connectivity.js';
import { JobStore } from '../jobs/job-store.js';
import type { ActivityAccess, VaultSetup } from '../server/app.js';
import { startAgentAccess, type AgentAccess } from '../server/agent-access.js';
import { startServer, type RunningServer } from '../server/start.js';
import { clearImportJournal, recoverImport } from '../vault/transfer-files.js';
import { createVaultDirectory, inspectVaultDirectory } from '../vault/vault-directory.js';
import { importNewVault } from '../vault/vault-import.js';
import { VaultSelection } from '../vault/vault-selection.js';
import { forwarding, subscriptionCollections, VaultWorkspace, type WorkspaceOptions } from '../vault/workspace.js';

export type CollectorRuntimeState = 'starting' | 'ready' | 'not_ready' | 'stopping' | 'stopped' | 'unavailable';

export interface CollectorRuntimeStatus {
  state: CollectorRuntimeState;
  instanceId: string;
  profilePath: string;
  vaultPath: string | null;
  message: string;
}

/** Everything a workspace needs except the Vault location, which the runtime decides. */
export type VaultServiceOptions = Omit<WorkspaceOptions, 'root' | 'selection' | 'createdBy' | 'profilePath' | 'pause' | 'connectivity'>;

export interface CollectorRuntimeOptions {
  profilePath: string;
  /** Null runs only health and Agent identity, without any Vault services. */
  workspace: VaultServiceOptions | null;
  /** How the device's network is confirmed; the internet probe and its intervals by default. */
  connectivity?: Omit<ConnectivityOptions, 'pause'>;
  /** The device's collection pause, when the caller sets reasons on it before the runtime starts; a new one otherwise. */
  pause?: CollectionPause;
  /** Uses this Vault instead of the device selection; an empty directory becomes a new Vault. */
  explicitVaultPath?: string;
  /** Location Onboarding proposes for a new Vault. */
  suggestedVaultPath?: string;
  /** Application name and version recorded in Vaults this runtime creates. */
  createdBy?: string;
  connectionFile: string;
  skillPath: string;
  /** Preferred Agent API port; the Agent API takes any free port when omitted. */
  agentPort?: number;
  uiPort: number;
  uiHost?: string;
  webRoot?: string;
  /** Packaged desktop login-startup service; absent servers report the setting unavailable. */
  loginStartup?: LoginStartupAccess;
  /** Records a packaged OS login launch in the device activity log. */
  startedAtLogin?: boolean;
}

const NOT_SET_MESSAGE = '尚未設定 Vault。請在 UI Onboarding 選擇或建立 Vault，或呼叫 POST /api/vault/setup。';

/** Owns the one workspace, scheduler and pair of UI/Agent HTTP listeners for a process. */
export class CollectorRuntime {
  readonly instanceId: string;
  readonly profilePath: string;
  readonly server: RunningServer;
  readonly agentAccess: AgentAccess;
  /** The device's collection pause, followed by the scheduler and jobs of whichever Vault is open. */
  readonly pause: CollectionPause;
  readonly connectivity: Connectivity;
  private workspaceValue: VaultWorkspace | null;
  private failure: { path: string; reason: string } | null;
  private stateValue: CollectorRuntimeState;
  private message: string;
  private settingUp = false;
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly options: CollectorRuntimeOptions,
    private readonly services: WorkspaceServices | null,
    private readonly selection: VaultSelection,
    instanceId: string,
    initial: Opening,
    agentAccess: AgentAccess,
    server: RunningServer,
    private readonly jobStore: JobStore | null,
    pause: CollectionPause,
    connectivity: Connectivity,
  ) {
    this.pause = pause;
    this.connectivity = connectivity;
    this.instanceId = instanceId;
    this.profilePath = path.resolve(options.profilePath);
    this.workspaceValue = initial.workspace;
    this.failure = initial.failure;
    this.agentAccess = agentAccess;
    this.server = server;
    this.stateValue = initial.workspace ? 'ready' : 'not_ready';
    this.message = initial.workspace ? '服務已就緒。' : initial.message;
  }

  get workspace(): VaultWorkspace | null { return this.workspaceValue; }

  /** Records a device-wide desktop event; global events stay visible with any Vault selected. */
  recordDeviceEvent(severity: 'info' | 'warning' | 'error', eventType: string, message: string, errorCode?: string): void {
    this.jobStore?.event({ severity, eventType, message, vaultPath: null, jobId: null, ...(errorCode ? { errorCode } : {}) });
  }

  static async start(options: CollectorRuntimeOptions): Promise<CollectorRuntime> {
    const instanceId = randomUUID();
    const selection = new VaultSelection(path.join(options.profilePath, 'vault-selection.json'));
    let initial: Opening = { workspace: null, failure: null, message: NOT_SET_MESSAGE };
    let agentAccess: AgentAccess | null = null;
    let runtime: CollectorRuntime | null = null;
    const current = (): VaultWorkspace => {
      const workspace = runtime ? runtime.workspaceValue : initial.workspace;
      if (!workspace) throw new CollectorError('vault_not_ready', runtime?.message ?? initial.message);
      return workspace;
    };
    const runtimeStatus = (): CollectorRuntimeStatus => runtime?.status() ?? {
      state: 'starting', instanceId, profilePath: path.resolve(options.profilePath),
      vaultPath: initial.workspace?.status().vaultPath ?? null, message: '服務啟動中。',
    };
    // Collection jobs are device data kept in the profile, across every Vault this device opens.
    const jobStore = options.workspace ? await JobStore.open(path.join(options.profilePath, 'jobs')) : null;
    const deviceEvent = (severity: 'info' | 'warning' | 'error', eventType: string, message: string, errorCode?: string) => {
      jobStore?.event({ severity, eventType, message, vaultPath: null, jobId: null, ...(errorCode ? { errorCode } : {}) });
    };
    if (options.startedAtLogin) deviceEvent('info', 'device.login_startup_launched', 'XR Collector 由電腦登入自動啟動，並在背景執行。');
    const pause = options.pause ?? new CollectionPause();
    const connectivity = new Connectivity({ ...options.connectivity, pause });
    const workspaceServices: WorkspaceServices | null = options.workspace && jobStore ? { ...options.workspace, jobStore, pause, connectivity } : null;
    // Activity is read from the device log directly, so a Vault that is locked or not open never blocks it.
    const activity: ActivityAccess | undefined = jobStore ? {
      query: (query) => jobStore.activity.query(query,
        (runtime ? runtime.workspaceValue : initial.workspace)?.activityScope() ?? { vaultPath: null }),
      health: () => jobStore.activity.health(),
    } : undefined;
    const services = options.workspace ? {
      collector: forwarding(() => current().collector),
      jobs: forwarding(() => current().jobs),
      transfer: forwarding(() => current()),
      subscriptions: subscriptionCollections(() => current().subscriptions),
      schedule: forwarding(() => current().schedule),
      search: forwarding<TranscriptSearch>(() => current().search),
      ...(options.workspace.pacing ? { pacing: options.workspace.pacing } : {}),
    } : {};
    const loginStartup: LoginStartupAccess | undefined = options.loginStartup ? {
      status: () => options.loginStartup!.status(),
      update: async (enabled) => {
        try {
          const status = await options.loginStartup!.update(enabled);
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
    const shared = { ...services, connectivity, ...(loginStartup ? { loginStartup } : {}) };
    const vaultSetup: VaultSetup = {
      status: () => runtime!.vaultStatus(),
      inspect: (vaultPath) => inspectVaultDirectory(vaultPath),
      setup: (action, vaultPath, packagePath) => runtime!.setup(action, vaultPath, packagePath),
    };
    const notReady = () => runtime ? (runtime.workspaceValue ? null : runtime.message) : initial.message;
    try {
      if (workspaceServices) {
        // An import from Onboarding a stop interrupted is taken back unless the selection already names its Vault.
        await recoverImport(options.profilePath, [await selection.read().catch(() => null)]);
        initial = await CollectorRuntime.openInitial(options, workspaceServices, selection);
      }
      agentAccess = await startAgentAccess({
        ...shared, instanceId,
        ...(activity && jobStore ? { activity, protectSecret: (secret: string) => jobStore.activity.protectSecret(secret) } : {}),
        ...(options.agentPort ? { preferredPort: options.agentPort } : {}),
        connectionFile: options.connectionFile,
        skillPath: options.skillPath,
        runtimeStatus, notReady, vaultSetup,
      });
      const server = await startServer({
        ...shared,
        ...(activity ? { activity } : {}),
        port: options.uiPort,
        ...(options.uiHost ? { host: options.uiHost } : {}),
        ...(options.webRoot ? { webRoot: options.webRoot } : {}),
        agentInfo: agentAccess.info,
        runtimeStatus, notReady, vaultSetup,
      });
      runtime = new CollectorRuntime(options, workspaceServices, selection, instanceId, initial, agentAccess, server, jobStore, pause, connectivity);
      return runtime;
    } catch (error) {
      await agentAccess?.close().catch(() => undefined);
      await initial.workspace?.close().catch(() => undefined);
      await jobStore?.close().catch(() => undefined);
      connectivity.close();
      throw error;
    }
  }

  /** Opens the explicit or previously selected Vault; an unusable one leaves the runtime Not Ready. */
  private static async openInitial(
    options: CollectorRuntimeOptions,
    services: WorkspaceServices,
    selection: VaultSelection,
  ): Promise<Opening> {
    const createdBy = options.createdBy ?? 'XR Collector';
    const fixedLocation = Boolean(options.explicitVaultPath);
    const open = async (root: string): Promise<Opening> => ({
      workspace: await VaultWorkspace.open({
        ...services, root, selection, createdBy, profilePath: path.resolve(options.profilePath), fixedLocation,
      }), failure: null, message: '',
    });
    const unusable = (failurePath: string, reason: string): Opening => ({
      workspace: null, failure: { path: failurePath, reason }, message: `目前選擇的 Vault 無法使用：${reason}請在 UI Onboarding 重新選擇 Vault。`,
    });

    if (options.explicitVaultPath) {
      const inspection = await inspectVaultDirectory(path.resolve(options.explicitVaultPath));
      if (inspection.kind === 'empty') return open(await createVaultDirectory(inspection.path, createdBy));
      if (inspection.kind === 'existing') return open(inspection.path);
      return unusable(inspection.path, inspection.reason);
    }

    let selected: string | null;
    try {
      selected = await selection.read();
    } catch {
      return unusable(selection.file, '這台電腦的知識庫位置設定已損壞。');
    }
    if (!selected) return { workspace: null, failure: null, message: NOT_SET_MESSAGE };
    const inspection = await inspectVaultDirectory(selected);
    if (inspection.kind === 'existing') return open(inspection.path);
    if (inspection.kind === 'empty') {
      // A selected Vault that is now missing or empty must not be recreated silently.
      return unusable(selected, inspection.exists ? '先前使用的知識庫目錄已經是空的。' : '找不到先前使用的知識庫目錄。');
    }
    return unusable(selected, inspection.reason);
  }

  vaultStatus(): VaultSetupStatus {
    return {
      state: this.workspaceValue ? 'ready' : 'not_ready',
      vaultPath: this.workspaceValue?.status().vaultPath ?? null,
      suggestedPath: this.options.suggestedVaultPath ?? path.join(homedir(), 'Documents', 'XR Collector'),
      failure: this.workspaceValue ? null : this.failure,
    };
  }

  /**
   * Creates, opens or imports a Vault while Not Ready, then starts its services and remembers the
   * location. An import creates the Vault in `vaultPath` (missing or empty) from the export file
   * `packagePath`; the automatic collection switch is the one the export file holds.
   */
  async setup(action: VaultSetupAction, vaultPath: string, packagePath?: string): Promise<VaultSetupResult> {
    if (!this.services) throw new CollectorError('vault_not_ready', '此執行環境沒有提供 Vault 服務。');
    if (this.closing) throw new CollectorError('vault_busy', '服務正在停止。');
    if (this.workspaceValue) throw new CollectorError('vault_already_set', '已經有使用中的知識庫。更換位置請使用搬移功能。');
    if (this.settingUp) throw new CollectorError('vault_busy', '正在設定知識庫，請等待目前的操作完成。');
    if (!path.isAbsolute(vaultPath)) throw new CollectorError('invalid_request', '請提供完整的絕對路徑。');
    this.settingUp = true;
    try {
      const createdBy = this.options.createdBy ?? 'XR Collector';
      let root: string;
      let documentCount = 0;
      if (action === 'create') {
        root = await createVaultDirectory(vaultPath, createdBy);
      } else if (action === 'import') {
        root = await importNewVault({
          packageFile: packagePath, folder: vaultPath, profilePath: this.profilePath, createdBy,
          ...(this.services.statfs ? { statfs: this.services.statfs } : {}),
        });
        documentCount = (await inspectVaultDirectory(root).then((inspection) => inspection.kind === 'existing' ? inspection.documentCount : 0));
      } else {
        const inspection: VaultInspection = await inspectVaultDirectory(vaultPath);
        if (inspection.kind === 'empty') throw new CollectorError('vault_invalid', '這個目錄還不是知識庫，請改用建立。');
        if (inspection.kind === 'invalid') throw new CollectorError('vault_invalid', inspection.reason);
        root = inspection.path;
        documentCount = inspection.documentCount;
      }
      let workspace: VaultWorkspace;
      try {
        // An imported Vault keeps its import journal until the selection names it, so a failure or a
        // stop before that takes the new folder back.
        workspace = await VaultWorkspace.open({
          ...this.services, root, selection: this.selection, createdBy, profilePath: this.profilePath, pendingImport: action === 'import',
        });
      } catch (error) {
        console.error('Vault services failed to start', error);
        if (action === 'import') await recoverImport(this.profilePath, []).catch(() => undefined);
        throw new CollectorError('vault_invalid', '知識庫無法啟動，請確認目錄內容與搜尋服務後重試。', { cause: error });
      }
      try {
        await this.selection.write(root);
      } catch (error) {
        await workspace.close().catch(() => undefined);
        if (action === 'import') await recoverImport(this.profilePath, []).catch(() => undefined);
        throw new CollectorError('vault_invalid', '無法保存知識庫位置，請確認程式資料目錄可寫入後重試。', { cause: error });
      }
      if (action === 'import') await clearImportJournal(this.profilePath);
      this.workspaceValue = workspace;
      this.failure = null;
      this.stateValue = 'ready';
      this.message = '服務已就緒。';
      return { vault: this.vaultStatus(), documentCount };
    } finally {
      this.settingUp = false;
    }
  }

  status(): CollectorRuntimeStatus {
    return {
      state: this.stateValue,
      instanceId: this.instanceId,
      profilePath: this.profilePath,
      vaultPath: this.workspaceValue?.status().vaultPath ?? null,
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
    // Each listener stops accepting requests and waits for accepted handlers,
    // including work whose client disconnected, before the workspace stops.
    // A confirmation under way is given up, so no job waits on it while the workspace stops.
    this.connectivity.close();
    const listeners = await Promise.allSettled([this.server.close(), this.agentAccess.close()]);
    const workspace = this.workspaceValue ? await Promise.allSettled([this.workspaceValue.close()]) : [];
    // Jobs and activity close last; the workspace records interrupted jobs into them while it stops.
    const store = this.jobStore ? await Promise.allSettled([this.jobStore.close()]) : [];
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

/** The services every Vault this runtime opens shares: the caller's, with the device's job record, pause and network. */
type WorkspaceServices = VaultServiceOptions & Required<Pick<WorkspaceOptions, 'jobStore' | 'pause' | 'connectivity'>>;

interface Opening {
  workspace: VaultWorkspace | null;
  failure: { path: string; reason: string } | null;
  message: string;
}

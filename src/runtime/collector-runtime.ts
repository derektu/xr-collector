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
import type { VaultSetup } from '../server/app.js';
import { startAgentAccess, type AgentAccess } from '../server/agent-access.js';
import { startServer, type RunningServer } from '../server/start.js';
import { createVaultDirectory, inspectVaultDirectory } from '../vault/vault-directory.js';
import { VaultSelection } from '../vault/vault-selection.js';
import { forwarding, VaultWorkspace, type WorkspaceOptions } from '../vault/workspace.js';

export type CollectorRuntimeState = 'starting' | 'ready' | 'not_ready' | 'stopping' | 'stopped' | 'unavailable';

export interface CollectorRuntimeStatus {
  state: CollectorRuntimeState;
  instanceId: string;
  profilePath: string;
  vaultPath: string | null;
  message: string;
}

/** Everything a workspace needs except the Vault location, which the runtime decides. */
export type VaultServiceOptions = Omit<WorkspaceOptions, 'root' | 'selection' | 'createdBy'>;

export interface CollectorRuntimeOptions {
  profilePath: string;
  /** Null runs only health and Agent identity, without any Vault services. */
  workspace: VaultServiceOptions | null;
  /** Uses this Vault instead of the device selection; an empty directory becomes a new Vault. */
  explicitVaultPath?: string;
  /** Location Onboarding proposes for a new Vault. */
  suggestedVaultPath?: string;
  /** Application name and version recorded in Vaults this runtime creates. */
  createdBy?: string;
  connectionFile: string;
  skillPath: string;
  uiPort: number;
  uiHost?: string;
  webRoot?: string;
}

const NOT_SET_MESSAGE = '尚未設定 Vault。請在 UI Onboarding 選擇或建立 Vault，或呼叫 POST /api/vault/setup。';

/** Owns the one workspace, scheduler and pair of UI/Agent HTTP listeners for a process. */
export class CollectorRuntime {
  readonly instanceId: string;
  readonly profilePath: string;
  readonly server: RunningServer;
  readonly agentAccess: AgentAccess;
  private workspaceValue: VaultWorkspace | null;
  private failure: { path: string; reason: string } | null;
  private stateValue: CollectorRuntimeState;
  private message: string;
  private settingUp = false;
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly options: CollectorRuntimeOptions,
    private readonly selection: VaultSelection,
    instanceId: string,
    initial: Opening,
    agentAccess: AgentAccess,
    server: RunningServer,
  ) {
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
    const services = options.workspace ? {
      collector: forwarding(() => current().collector),
      transfer: forwarding(() => current()),
      channels: forwarding(() => current().channels),
      schedule: forwarding(() => current().schedule),
      search: forwarding<TranscriptSearch>(() => current().search),
    } : {};
    const vaultSetup: VaultSetup = {
      status: () => runtime!.vaultStatus(),
      inspect: (vaultPath) => inspectVaultDirectory(vaultPath),
      setup: (action, vaultPath) => runtime!.setup(action, vaultPath),
    };
    const notReady = () => runtime ? (runtime.workspaceValue ? null : runtime.message) : initial.message;
    try {
      if (options.workspace) initial = await CollectorRuntime.openInitial(options, options.workspace, selection);
      agentAccess = await startAgentAccess({
        ...services, instanceId,
        connectionFile: options.connectionFile,
        skillPath: options.skillPath,
        runtimeStatus, notReady, vaultSetup,
      });
      const server = await startServer({
        ...services,
        port: options.uiPort,
        ...(options.uiHost ? { host: options.uiHost } : {}),
        ...(options.webRoot ? { webRoot: options.webRoot } : {}),
        agentInfo: agentAccess.info,
        runtimeStatus, notReady, vaultSetup,
      });
      runtime = new CollectorRuntime(options, selection, instanceId, initial, agentAccess, server);
      return runtime;
    } catch (error) {
      await agentAccess?.close().catch(() => undefined);
      await initial.workspace?.close().catch(() => undefined);
      throw error;
    }
  }

  /** Opens the explicit or previously selected Vault; an unusable one leaves the runtime Not Ready. */
  private static async openInitial(
    options: CollectorRuntimeOptions,
    services: VaultServiceOptions,
    selection: VaultSelection,
  ): Promise<Opening> {
    const createdBy = options.createdBy ?? 'XR Collector';
    const open = async (root: string): Promise<Opening> => ({
      workspace: await VaultWorkspace.open({ ...services, root, selection, createdBy }), failure: null, message: '',
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

  /** Creates or opens a Vault while Not Ready, then starts its services and remembers the location. */
  async setup(action: VaultSetupAction, vaultPath: string): Promise<VaultSetupResult> {
    if (!this.options.workspace) throw new CollectorError('vault_not_ready', '此執行環境沒有提供 Vault 服務。');
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
      } else {
        const inspection: VaultInspection = await inspectVaultDirectory(vaultPath);
        if (inspection.kind === 'empty') throw new CollectorError('vault_invalid', '這個目錄還不是知識庫，請改用建立。');
        if (inspection.kind === 'invalid') throw new CollectorError('vault_invalid', inspection.reason);
        root = inspection.path;
        documentCount = inspection.documentCount;
      }
      let workspace: VaultWorkspace;
      try {
        workspace = await VaultWorkspace.open({ ...this.options.workspace, root, selection: this.selection, createdBy });
      } catch (error) {
        console.error('Vault services failed to start', error);
        throw new CollectorError('vault_invalid', '知識庫無法啟動，請確認目錄內容與搜尋服務後重試。', { cause: error });
      }
      try {
        await this.selection.write(root);
      } catch (error) {
        await workspace.close().catch(() => undefined);
        throw new CollectorError('vault_invalid', '無法保存知識庫位置，請確認程式資料目錄可寫入後重試。', { cause: error });
      }
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
    const listeners = await Promise.allSettled([this.server.close(), this.agentAccess.close()]);
    const workspace = this.workspaceValue ? await Promise.allSettled([this.workspaceValue.close()]) : [];
    const failed = [...listeners, ...workspace]
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

interface Opening {
  workspace: VaultWorkspace | null;
  failure: { path: string; reason: string } | null;
  message: string;
}

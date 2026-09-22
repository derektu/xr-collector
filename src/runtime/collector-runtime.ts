import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startAgentAccess, type AgentAccess } from '../server/agent-access.js';
import { startServer, type RunningServer } from '../server/start.js';
import {
  ActiveVaultUnavailableError,
  VaultWorkspace,
  type WorkspaceOptions,
} from '../vault/workspace.js';

export type CollectorRuntimeState = 'starting' | 'ready' | 'not_ready' | 'stopping' | 'stopped' | 'unavailable';

export interface CollectorRuntimeStatus {
  state: CollectorRuntimeState;
  instanceId: string;
  profilePath: string;
  vaultPath: string | null;
  message: string;
}

export interface CollectorRuntimeOptions {
  profilePath: string;
  workspace: WorkspaceOptions | null;
  connectionFile: string;
  skillPath: string;
  uiPort: number;
  uiHost?: string;
  webRoot?: string;
}

/** Owns the one workspace, scheduler and pair of UI/Agent HTTP listeners for a process. */
export class CollectorRuntime {
  readonly instanceId: string;
  readonly profilePath: string;
  readonly workspace: VaultWorkspace | null;
  readonly server: RunningServer;
  readonly agentAccess: AgentAccess;
  private stateValue: CollectorRuntimeState = 'starting';
  private message = '服務啟動中。';
  private closing: Promise<void> | null = null;

  private constructor(
    options: CollectorRuntimeOptions,
    instanceId: string,
    workspace: VaultWorkspace | null,
    agentAccess: AgentAccess,
    server: RunningServer,
    notReadyMessage?: string,
  ) {
    this.instanceId = instanceId;
    this.profilePath = path.resolve(options.profilePath);
    this.workspace = workspace;
    this.agentAccess = agentAccess;
    this.server = server;
    this.stateValue = notReadyMessage ? 'not_ready' : 'ready';
    this.message = notReadyMessage ?? '服務已就緒。';
  }

  static async start(options: CollectorRuntimeOptions): Promise<CollectorRuntime> {
    const instanceId = randomUUID();
    let workspace: VaultWorkspace | null = null;
    let agentAccess: AgentAccess | null = null;
    let runtime: CollectorRuntime | null = null;
    let notReadyMessage: string | undefined;
    const runtimeStatus = (): CollectorRuntimeStatus => runtime?.status() ?? {
      state: 'starting', instanceId, profilePath: path.resolve(options.profilePath),
      vaultPath: workspace?.status().vaultPath ?? null, message: '服務啟動中。',
    };
    try {
      if (options.workspace) {
        try {
          workspace = await VaultWorkspace.open(options.workspace);
        } catch (error) {
          if (!(error instanceof ActiveVaultUnavailableError)) throw error;
          notReadyMessage = error.message;
        }
      } else {
        notReadyMessage = '尚未設定 Vault。請在 UI Onboarding 選擇或建立 Vault。';
      }
      agentAccess = await startAgentAccess({
        ...(workspace ? {
          collector: workspace.collector,
          transfer: workspace,
          channels: workspace.channels,
          schedule: workspace.schedule,
          search: workspace.search,
        } : {}),
        instanceId,
        connectionFile: options.connectionFile,
        skillPath: options.skillPath,
        runtimeStatus,
        ...(notReadyMessage ? { notReadyMessage } : {}),
      });
      const server = await startServer({
        ...(workspace ? {
          collector: workspace.collector,
          transfer: workspace,
          channels: workspace.channels,
          schedule: workspace.schedule,
          search: workspace.search,
        } : {}),
        port: options.uiPort,
        ...(options.uiHost ? { host: options.uiHost } : {}),
        ...(options.webRoot ? { webRoot: options.webRoot } : {}),
        agentInfo: agentAccess.info,
        runtimeStatus,
        ...(notReadyMessage ? { notReadyMessage } : {}),
      });
      runtime = new CollectorRuntime(options, instanceId, workspace, agentAccess, server, notReadyMessage);
      return runtime;
    } catch (error) {
      await agentAccess?.close().catch(() => undefined);
      await workspace?.close().catch(() => undefined);
      throw error;
    }
  }

  status(): CollectorRuntimeStatus {
    return {
      state: this.stateValue,
      instanceId: this.instanceId,
      profilePath: this.profilePath,
      vaultPath: this.workspace?.status().vaultPath ?? null,
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
    const workspace = this.workspace ? await Promise.allSettled([this.workspace.close()]) : [];
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

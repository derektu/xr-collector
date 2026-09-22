import path from 'node:path';

export const AGENT_CONNECTION_FILE = 'agent-connection.json';
export const DEVELOPMENT_AGENT_CONNECTION_FILE = 'agent-connection.development.json';
export const XR_COLLECTOR_PRODUCT_DIRECTORY = 'XR Collector';

export interface AgentDiscoveryPathOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  profilePath: string;
  appDataPath: string;
  localAppDataPath?: string;
  hasExplicitProfile: boolean;
}

/** Keeps development profiles isolated while giving installed apps one stable per-user entrypoint. */
export function agentConnectionFile(options: AgentDiscoveryPathOptions): string {
  const targetPath = options.platform === 'win32' ? path.win32 : path.posix;
  if (options.hasExplicitProfile) {
    return targetPath.join(options.profilePath, AGENT_CONNECTION_FILE);
  }
  if (!options.isPackaged) {
    return targetPath.join(options.profilePath, DEVELOPMENT_AGENT_CONNECTION_FILE);
  }
  if (options.platform === 'win32') {
    if (!options.localAppDataPath) {
      throw new Error('LOCALAPPDATA is required to publish XR Collector Agent discovery on Windows');
    }
    return targetPath.join(options.localAppDataPath, XR_COLLECTOR_PRODUCT_DIRECTORY, AGENT_CONNECTION_FILE);
  }
  return targetPath.join(options.appDataPath, XR_COLLECTOR_PRODUCT_DIRECTORY, AGENT_CONNECTION_FILE);
}

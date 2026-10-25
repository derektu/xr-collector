import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createSourcePlugins } from '../plugins/index.js';
import { DEVELOPMENT_AGENT_PORT } from '../runtime/agent-discovery.js';
import { loadBuildInfo } from '../runtime/build-info.js';
import { CollectorRuntime } from '../runtime/collector-runtime.js';
import { backupFolder, exportFolder } from '../vault/transfer-files.js';

const projectRoot = process.cwd();
const profilePath = path.resolve(process.env.XR_COLLECTOR_PROFILE ?? path.join(projectRoot, '.data'));
const explicitVaultPath = process.env.XR_COLLECTOR_VAULT;
const webRoot = path.join(projectRoot, 'dist', 'web');
const platformDirectory = process.platform === 'win32' ? 'win' : 'mac';
const runtimeRoot = path.join(projectRoot, 'resources', 'bin', platformDirectory);
const port = Number.parseInt(process.env.XR_COLLECTOR_PORT ?? '7175', 10);
const searchPort = process.env.XR_COLLECTOR_MEILISEARCH_PORT
  ? Number.parseInt(process.env.XR_COLLECTOR_MEILISEARCH_PORT, 10)
  : undefined;
const executable = (name: string) => process.platform === 'win32' ? `${name}.exe` : name;
const binary = (environmentName: string, name: string) => process.env[environmentName]
  ?? path.join(runtimeRoot, executable(name));

const sources = await createSourcePlugins({
  profilePath,
  env: process.env,
  program: (name, environmentName) => binary(environmentName, name),
});
const runtime = await CollectorRuntime.start({
  buildInfo: await loadBuildInfo(),
  profilePath,
  workspace: {
    plugins: sources.plugins,
    pacing: sources.pacing,
    searchBinary: binary('XR_COLLECTOR_MEILISEARCH', 'meilisearch'),
    searchData: path.resolve(process.env.XR_COLLECTOR_SEARCH_DATA ?? path.join(profilePath, 'dev-search')),
    ...(searchPort ? { searchPort } : {}),
    exportFolder: exportFolder(path.join(homedir(), 'Documents')),
    backupFolder: backupFolder(path.join(homedir(), 'Documents')),
  },
  ...(explicitVaultPath ? { explicitVaultPath: path.resolve(explicitVaultPath) } : {}),
  createdBy: 'XR Collector (development server)',
  connectionFile: path.join(profilePath, 'agent-connection.json'),
  skillPath: path.join(projectRoot, 'skills', 'xr-collector-agent'),
  agentPort: process.env.XR_COLLECTOR_AGENT_PORT ? Number.parseInt(process.env.XR_COLLECTOR_AGENT_PORT, 10) : DEVELOPMENT_AGENT_PORT,
  uiPort: port,
  ...(existsSync(webRoot) ? { webRoot } : {}),
});

console.log(`XR Collector API listening at ${runtime.server.url}`);
console.log(`Vault: ${runtime.status().vaultPath ?? `not ready — ${runtime.status().message}`}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { await runtime.close(); process.exitCode = 0; }
  catch (error) { console.error(error); process.exitCode = 1; }
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

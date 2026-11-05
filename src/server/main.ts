import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createSourcePlugins } from '../plugins/index.js';
import { DEVELOPMENT_AGENT_PORT } from '../runtime/agent-connection-defaults.js';
import { loadBuildInfo } from '../updates/build-info.js';
import { bundledResources, checkoutRoot } from '../runtime/bundled-resources.js';
import { startCollectorServer } from './collector-server.js';
import { backupFolder, exportFolder } from '../vault/transfer-files.js';

const projectRoot = checkoutRoot();
const resources = bundledResources({ packaged: false, checkout: projectRoot });
const profilePath = path.resolve(process.env.XR_COLLECTOR_PROFILE ?? path.join(projectRoot, '.data'));
const explicitVaultPath = process.env.XR_COLLECTOR_VAULT;
const webRoot = path.join(projectRoot, 'dist', 'web');
const port = Number.parseInt(process.env.XR_COLLECTOR_PORT ?? '7175', 10);
const searchPort = process.env.XR_COLLECTOR_MEILISEARCH_PORT
  ? Number.parseInt(process.env.XR_COLLECTOR_MEILISEARCH_PORT, 10)
  : undefined;

const sources = await createSourcePlugins({
  profilePath,
  env: process.env,
  program: resources.program,
});
const runtime = await startCollectorServer({
  buildInfo: await loadBuildInfo(),
  profilePath,
  sources: sources.registry,
  workspace: {
    plugins: sources.plugins,
    pacing: sources.pacing,
    searchBinary: resources.searchBinary,
    searchLexicon: resources.searchLexicon,
    searchData: path.resolve(process.env.XR_COLLECTOR_SEARCH_DATA ?? path.join(profilePath, 'dev-search')),
    ...(searchPort ? { searchPort } : {}),
    exportFolder: exportFolder(path.join(homedir(), 'Documents')),
    backupFolder: backupFolder(path.join(homedir(), 'Documents')),
  },
  ...(explicitVaultPath ? { explicitVaultPath: path.resolve(explicitVaultPath) } : {}),
  createdBy: 'XR Collector (development server)',
  agentSettingsFile: path.join(profilePath, 'agent-settings.json'),
  skillPath: resources.skill,
  agentPort: process.env.XR_COLLECTOR_AGENT_PORT ? Number.parseInt(process.env.XR_COLLECTOR_AGENT_PORT, 10) : DEVELOPMENT_AGENT_PORT,
  uiPort: port,
  ...(existsSync(webRoot) ? { webRoot } : {}),
});

console.log(`XR Collector API listening at ${runtime.listeners.ui.url}`);
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

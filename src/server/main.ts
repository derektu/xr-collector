import { existsSync } from 'node:fs';
import path from 'node:path';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { VaultWorkspace } from '../vault/workspace.js';
import { startServer } from './start.js';
import { startAgentAccess } from './agent-access.js';

const projectRoot = process.cwd();
const vaultRoot = path.resolve(
  process.env.XR_COLLECTOR_VAULT ?? path.join(projectRoot, '.data', 'dev-vault'),
);
const webRoot = path.join(projectRoot, 'dist', 'web');
const runtimeRoot = path.join(projectRoot, 'resources', 'bin', 'mac');
const port = Number.parseInt(process.env.XR_COLLECTOR_PORT ?? '7175', 10);
const searchPort = Number.parseInt(process.env.XR_COLLECTOR_MEILISEARCH_PORT ?? '7177', 10);

const capture = new YtDlpCapture({
  binaryPath: process.env.XR_COLLECTOR_YTDLP ?? path.join(runtimeRoot, 'yt-dlp'),
  javaScriptRuntimePath: process.env.XR_COLLECTOR_DENO ?? path.join(runtimeRoot, 'deno'),
});
const channelSource = new YtDlpChannelSource({
  binaryPath: process.env.XR_COLLECTOR_YTDLP ?? path.join(runtimeRoot, 'yt-dlp'),
  javaScriptRuntimePath: process.env.XR_COLLECTOR_DENO ?? path.join(runtimeRoot, 'deno'),
});
const workspace = await VaultWorkspace.open({
  defaultRoot: vaultRoot, capture, channelSource,
  searchBinary: process.env.XR_COLLECTOR_MEILISEARCH ?? path.join(runtimeRoot, 'meilisearch'),
  searchData: path.resolve(process.env.XR_COLLECTOR_SEARCH_DATA ?? path.join(projectRoot, '.data', 'dev-search')),
  searchPort,
});
const { collector, channels, schedule, search } = workspace;
const agentAccess = await startAgentAccess({
  collector,
  search,
  connectionFile: path.join(projectRoot, '.data', 'agent-connection.json'),
  skillPath: path.join(projectRoot, 'skills', 'xr-collector-agent'),
});
const server = await startServer({
  collector,
  transfer: workspace,
  channels,
  schedule,
  search,
  port,
  agentInfo: agentAccess.info,
  ...(existsSync(webRoot) ? { webRoot } : {}),
});

console.log(`XR Collector API listening at ${server.url}`);
console.log(`Vault: ${vaultRoot}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await schedule.close();
  await server.close();
  await agentAccess.close();
  await workspace.close();
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

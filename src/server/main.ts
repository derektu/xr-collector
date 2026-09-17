import { existsSync } from 'node:fs';
import path from 'node:path';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { ChannelCollector } from '../channels/channel-collector.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { Collector } from '../core/collector.js';
import { startSearchRuntime } from '../search/runtime.js';
import { MarkdownVault } from '../vault/markdown-vault.js';
import { startServer } from './start.js';

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
const vault = new MarkdownVault(vaultRoot);
const searchRuntime = await startSearchRuntime({
  vault,
  binaryPath: process.env.XR_COLLECTOR_MEILISEARCH
    ?? path.join(runtimeRoot, 'meilisearch'),
  databasePath: path.resolve(
    process.env.XR_COLLECTOR_SEARCH_DATA ?? path.join(projectRoot, '.data', 'dev-search'),
  ),
  port: searchPort,
});
const collector = new Collector(capture, vault, searchRuntime.search);
const channels = new ChannelCollector(channelSource, new JsonChannelStore(vaultRoot), collector);
const server = await startServer({
  collector,
  channels,
  search: searchRuntime.search,
  port,
  ...(existsSync(webRoot) ? { webRoot } : {}),
});

console.log(`XR Collector API listening at ${server.url}`);
console.log(`Vault: ${vaultRoot}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  await searchRuntime.close();
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

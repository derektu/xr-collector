import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { YtDlpChannelSource } from '../capture/ytdlp-channel-source.js';
import { YouTubeGate, youtubeGateOptionsFromEnv } from '../capture/youtube-gate.js';
import { CollectorRuntime } from '../runtime/collector-runtime.js';
import { exportFolder } from '../vault/transfer-files.js';

const projectRoot = process.cwd();
const profilePath = path.resolve(process.env.XR_COLLECTOR_PROFILE ?? path.join(projectRoot, '.data'));
const explicitVaultPath = process.env.XR_COLLECTOR_VAULT;
const webRoot = path.join(projectRoot, 'dist', 'web');
const platformDirectory = process.platform === 'win32' ? 'win' : 'mac';
const runtimeRoot = path.join(projectRoot, 'resources', 'bin', platformDirectory);
const port = Number.parseInt(process.env.XR_COLLECTOR_PORT ?? '7175', 10);
const searchPort = Number.parseInt(process.env.XR_COLLECTOR_MEILISEARCH_PORT ?? '7177', 10);
const executable = (name: string) => process.platform === 'win32' ? `${name}.exe` : name;
const binary = (environmentName: string, name: string) => process.env[environmentName]
  ?? path.join(runtimeRoot, executable(name));

const youtubeGate = await YouTubeGate.open({
  statePath: path.join(profilePath, 'youtube-pacing.json'),
  ...youtubeGateOptionsFromEnv(process.env),
});
const captureOptions = {
  binaryPath: binary('XR_COLLECTOR_YTDLP', 'yt-dlp'),
  javaScriptRuntimePath: binary('XR_COLLECTOR_DENO', 'deno'),
  gate: youtubeGate,
};
const runtime = await CollectorRuntime.start({
  profilePath,
  workspace: {
    capture: new YtDlpCapture(captureOptions),
    channelSource: new YtDlpChannelSource(captureOptions),
    pacing: youtubeGate,
    searchBinary: binary('XR_COLLECTOR_MEILISEARCH', 'meilisearch'),
    searchData: path.resolve(process.env.XR_COLLECTOR_SEARCH_DATA ?? path.join(profilePath, 'dev-search')),
    searchPort,
    exportFolder: exportFolder(path.join(homedir(), 'Documents')),
  },
  ...(explicitVaultPath ? { explicitVaultPath: path.resolve(explicitVaultPath) } : {}),
  createdBy: 'XR Collector (development server)',
  connectionFile: path.join(profilePath, 'agent-connection.json'),
  skillPath: path.join(projectRoot, 'skills', 'xr-collector-agent'),
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

import { existsSync } from 'node:fs';
import path from 'node:path';
import { YtDlpCapture } from '../capture/ytdlp-capture.js';
import { Collector } from '../core/collector.js';
import { MarkdownVault } from '../vault/markdown-vault.js';
import { startServer } from './start.js';

const projectRoot = process.cwd();
const vaultRoot = path.resolve(
  process.env.XR_COLLECTOR_VAULT ?? path.join(projectRoot, '.data', 'dev-vault'),
);
const webRoot = path.join(projectRoot, 'dist', 'web');
const port = Number.parseInt(process.env.XR_COLLECTOR_PORT ?? '7175', 10);

const capture = new YtDlpCapture({
  binaryPath: process.env.XR_COLLECTOR_YTDLP ?? 'yt-dlp',
  ...(process.env.XR_COLLECTOR_DENO
    ? { javaScriptRuntimePath: process.env.XR_COLLECTOR_DENO }
    : {}),
});
const collector = new Collector(capture, new MarkdownVault(vaultRoot));
const server = await startServer({
  collector,
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
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

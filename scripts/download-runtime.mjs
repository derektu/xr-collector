import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (target !== 'mac') {
  console.error('Usage: node scripts/download-runtime.mjs mac');
  process.exit(1);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectRoot, 'resources', 'bin', 'mac');
const downloads = {
  ytDlp: {
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos',
    sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
  },
  deno: {
    url: 'https://github.com/denoland/deno/releases/download/v2.9.6/deno-aarch64-apple-darwin.zip',
    sha256: '213a2f304f04d3c9cb5220669afad138f60a5aab1fe80962abdeb8f35807a472',
  },
};

async function download(url, expectedSha256, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  await writeFile(destination, bytes);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

await mkdir(outputDir, { recursive: true });
const workDir = await mkdtemp(path.join(tmpdir(), 'xr-collector-runtime-'));
try {
  const ytDlpTemp = path.join(workDir, 'yt-dlp');
  console.log('Downloading pinned yt-dlp 2026.08.19…');
  await download(downloads.ytDlp.url, downloads.ytDlp.sha256, ytDlpTemp);
  await chmod(ytDlpTemp, 0o755);
  await rm(path.join(outputDir, 'yt-dlp'), { force: true });
  await rename(ytDlpTemp, path.join(outputDir, 'yt-dlp'));

  const denoZip = path.join(workDir, 'deno.zip');
  console.log('Downloading pinned Deno 2.9.6…');
  await download(downloads.deno.url, downloads.deno.sha256, denoZip);
  await run('unzip', ['-q', '-o', denoZip, '-d', workDir]);
  const denoTemp = path.join(workDir, 'deno');
  await chmod(denoTemp, 0o755);
  await rm(path.join(outputDir, 'deno'), { force: true });
  await rename(denoTemp, path.join(outputDir, 'deno'));
  console.log(`Runtime binaries ready in ${outputDir}`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

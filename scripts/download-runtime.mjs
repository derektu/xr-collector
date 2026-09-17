import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
  meilisearch: {
    url: 'https://github.com/meilisearch/meilisearch/releases/download/v1.53.2/meilisearch-macos-apple-silicon',
    sha256: '7fa492746343c1dd7217ead82fc6d42e74c1304593e4604f52ca71cf44d61b28',
  },
};

async function download(url, expectedSha256, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  if (!response.body) throw new Error(`Download returned no body: ${url}`);
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: 'wx' }),
  );
  const actual = await fileSha256(destination);
  if (actual !== expectedSha256) {
    await rm(destination, { force: true });
    throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
}

async function matchesChecksum(filePath, expectedSha256) {
  try {
    return await fileSha256(filePath) === expectedSha256;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
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

function reportsVersion(command, expectedVersion) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0 && output.includes(expectedVersion)));
  });
}

await mkdir(outputDir, { recursive: true });
const workDir = await mkdtemp(path.join(tmpdir(), 'xr-collector-runtime-'));
try {
  const ytDlpPath = path.join(outputDir, 'yt-dlp');
  if (await matchesChecksum(ytDlpPath, downloads.ytDlp.sha256)) {
    console.log('Pinned yt-dlp 2026.08.19 is already available.');
  } else {
    const ytDlpTemp = path.join(workDir, 'yt-dlp');
    console.log('Downloading pinned yt-dlp 2026.08.19…');
    await download(downloads.ytDlp.url, downloads.ytDlp.sha256, ytDlpTemp);
    await chmod(ytDlpTemp, 0o755);
    await rm(ytDlpPath, { force: true });
    await rename(ytDlpTemp, ytDlpPath);
  }

  const denoPath = path.join(outputDir, 'deno');
  if (await reportsVersion(denoPath, 'deno 2.9.6')) {
    console.log('Pinned Deno 2.9.6 is already available.');
  } else {
    const denoZip = path.join(workDir, 'deno.zip');
    console.log('Downloading pinned Deno 2.9.6…');
    await download(downloads.deno.url, downloads.deno.sha256, denoZip);
    await run('unzip', ['-q', '-o', denoZip, '-d', workDir]);
    const denoTemp = path.join(workDir, 'deno');
    await chmod(denoTemp, 0o755);
    await rm(denoPath, { force: true });
    await rename(denoTemp, denoPath);
  }

  const meilisearchPath = path.join(outputDir, 'meilisearch');
  if (await matchesChecksum(meilisearchPath, downloads.meilisearch.sha256)) {
    console.log('Pinned Meilisearch 1.53.2 is already available.');
  } else {
    const meilisearchTemp = path.join(workDir, 'meilisearch');
    console.log('Downloading pinned Meilisearch 1.53.2…');
    await download(
      downloads.meilisearch.url,
      downloads.meilisearch.sha256,
      meilisearchTemp,
    );
    await chmod(meilisearchTemp, 0o755);
    await rm(meilisearchPath, { force: true });
    await rename(meilisearchTemp, meilisearchPath);
  }
  console.log(`Runtime binaries ready in ${outputDir}`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

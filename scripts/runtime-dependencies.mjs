#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinsPath = path.join(projectRoot, 'scripts', 'runtime-dependency-pins.json');

export async function prepareRuntimeDependencies(options, dependencies = {}) {
  const pins = dependencies.pins ?? JSON.parse(await readFile(pinsPath, 'utf8'));
  const pinnedTarget = pins.targets?.[options.target];
  if (!pinnedTarget) throw new Error(`Unsupported runtime dependency target ${options.target}.`);
  const windows = options.target === 'win32-x64';
  const target = {
    ...pinnedTarget,
    ytDlp: {
      archiveExecutable: windows ? 'yt-dlp.exe' : 'yt-dlp_macos',
      installedExecutable: windows ? 'yt-dlp/yt-dlp.exe' : 'yt-dlp/yt-dlp',
      ...pinnedTarget.ytDlp,
    },
    deno: {
      archiveExecutable: windows ? 'deno.exe' : 'deno',
      installedExecutable: windows ? 'deno.exe' : 'deno',
      ...pinnedTarget.deno,
    },
  };
  const outputDir = options.outputDir ?? path.join(projectRoot, 'resources', 'bin', target.directory);
  const cacheRoot = options.cacheRoot ?? path.join(projectRoot, '.local', 'runtime-downloads', options.target);
  const manifestPath = path.join(outputDir, 'runtime-dependencies.json');
  const expected = manifestHeader(pins.schemaVersion, options.target, target);
  await mkdir(outputDir, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });

  return withLock(path.join(cacheRoot, '.prepare.lock'), async () => {
    const installed = await readJson(manifestPath);
    if (installed && exactJson(withoutFiles(installed), expected) && await verifyInventory(outputDir, installed.files, installed.executables)) {
      if (await versionsMatch(outputDir, target, dependencies.reportsVersion ?? reportsVersion)) {
        console.log(`Verified pinned yt-dlp ${target.ytDlp.version} and Deno ${target.deno.version} for ${options.target}.`);
        return { target: options.target, outputDir, manifestPath, manifest: installed, cacheHit: true };
      }
    }

    const ytArchive = await verifiedArchive('yt-dlp', target.ytDlp, cacheRoot, dependencies.fetch ?? fetch);
    const denoArchive = await verifiedArchive('deno', target.deno, cacheRoot, dependencies.fetch ?? fetch);
    const stage = await mkdtemp(path.join(outputDir, '.runtime-install-'));
    try {
      const extract = dependencies.extractZip ?? extractZip;
      const ytStage = path.join(stage, 'yt-dlp');
      const denoStage = path.join(stage, 'deno-extract');
      await extract(ytArchive, ytStage);
      await extract(denoArchive, denoStage);
      const ytArchiveExecutable = path.join(ytStage, target.ytDlp.archiveExecutable);
      const ytInstalledName = path.basename(target.ytDlp.installedExecutable);
      if (path.basename(target.ytDlp.archiveExecutable) !== ytInstalledName) {
        await rename(ytArchiveExecutable, path.join(ytStage, ytInstalledName));
      }
      const denoSource = path.join(denoStage, target.deno.archiveExecutable);
      const denoStaged = path.join(stage, path.basename(target.deno.installedExecutable));
      await rename(denoSource, denoStaged);
      await chmod(path.join(ytStage, ytInstalledName), 0o755);
      await chmod(denoStaged, 0o755);
      const stagedTarget = {
        ...target,
        ytDlp: { ...target.ytDlp, installedExecutable: `yt-dlp/${ytInstalledName}` },
        deno: { ...target.deno, installedExecutable: path.basename(target.deno.installedExecutable) },
      };
      if (!await versionsMatch(stage, stagedTarget, dependencies.reportsVersion ?? reportsVersion)) {
        throw new Error(`Extracted runtime dependencies do not report the pinned versions for ${options.target}.`);
      }
      await rm(denoStage, { recursive: true, force: true });
      const files = await inventory(stage, ['yt-dlp', path.basename(target.deno.installedExecutable)]);
      const manifest = { ...expected, files };
      const stagedManifest = path.join(stage, 'runtime-dependencies.json');
      await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      await replaceOutputs(outputDir, [
        { source: ytStage, destination: path.join(outputDir, 'yt-dlp') },
        { source: denoStaged, destination: path.join(outputDir, path.basename(target.deno.installedExecutable)) },
        { source: stagedManifest, destination: manifestPath },
      ]);
      console.log(`Prepared pinned yt-dlp ${target.ytDlp.version} and Deno ${target.deno.version} for ${options.target}.`);
      return { target: options.target, outputDir, manifestPath, manifest, cacheHit: false };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}

export async function verifyRuntimeDependencyInstallation(outputDir, manifest, targetId = manifest?.target, pinsOverride) {
  const pins = pinsOverride ?? JSON.parse(await readFile(pinsPath, 'utf8'));
  const pinnedTarget = pins.targets?.[targetId];
  if (!manifest || !pinnedTarget) return false;
  const windows = targetId === 'win32-x64';
  const target = {
    ...pinnedTarget,
    ytDlp: { installedExecutable: windows ? 'yt-dlp/yt-dlp.exe' : 'yt-dlp/yt-dlp', ...pinnedTarget.ytDlp },
    deno: { installedExecutable: windows ? 'deno.exe' : 'deno', ...pinnedTarget.deno },
  };
  return exactJson(withoutFiles(manifest), manifestHeader(pins.schemaVersion, targetId, target))
    && await verifyInventory(outputDir, manifest.files, manifest.executables);
}

function manifestHeader(schemaVersion, targetId, target) {
  const dependency = (pin) => ({ version: pin.version, url: pin.url, archiveSha256: pin.sha256 });
  return {
    schemaVersion,
    target: targetId,
    dependencies: { ytDlp: dependency(target.ytDlp), deno: dependency(target.deno) },
    executables: { ytDlp: target.ytDlp.installedExecutable, deno: target.deno.installedExecutable },
  };
}

function withoutFiles(manifest) {
  const { files: _files, ...header } = manifest;
  return header;
}

async function verifiedArchive(name, pin, cacheRoot, request) {
  const destination = path.join(cacheRoot, `${name}-${pin.sha256}.zip`);
  if (await exists(destination) && await fileSha256(destination) === pin.sha256) return destination;
  await rm(destination, { force: true });
  const staging = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const response = await request(pin.url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Runtime dependency download failed: ${response.status} ${pin.url}`);
    if (!response.body) throw new Error(`Runtime dependency download returned no body: ${pin.url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(staging, { flags: 'wx' }));
    const actual = await fileSha256(staging);
    if (actual !== pin.sha256) throw new Error(`Runtime dependency checksum mismatch for ${pin.url}: expected ${pin.sha256}, got ${actual}.`);
    await rename(staging, destination);
    return destination;
  } finally {
    await rm(staging, { force: true });
  }
}

async function verifyInventory(root, files, executables) {
  if (!Array.isArray(files) || files.length === 0) return false;
  const expectedPaths = files.map((entry) => entry.path);
  if (!expectedPaths.every(safeRelativePath) || new Set(expectedPaths).size !== expectedPaths.length) return false;
  if (!safeRelativePath(executables?.ytDlp) || !safeRelativePath(executables?.deno)) return false;
  let actual;
  try { actual = await inventory(root, [path.dirname(executables.ytDlp), executables.deno]); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!exactJson(actual.map((entry) => entry.path), expectedPaths)) return false;
  for (const entry of files) {
    const target = path.join(root, entry.path);
    if ((await stat(target)).size !== entry.bytes || await fileSha256(target) !== entry.sha256) return false;
  }
  return true;
}

async function inventory(root, entries) {
  const files = [];
  for (const entry of entries) await collectFiles(root, entry, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectFiles(root, relative, files) {
  const target = path.join(root, relative);
  const info = await stat(target);
  if (info.isDirectory()) {
    for (const child of await readdir(target)) await collectFiles(root, path.posix.join(relative.replaceAll('\\', '/'), child), files);
    return;
  }
  files.push({ path: relative.replaceAll('\\', '/'), bytes: info.size, sha256: await fileSha256(target) });
}

async function versionsMatch(root, target, check) {
  return await check(path.join(root, target.ytDlp.installedExecutable), target.ytDlp.version)
    && await check(path.join(root, target.deno.installedExecutable), `deno ${target.deno.version}`);
}

function reportsVersion(command, expected) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0 && output.includes(expected)));
  });
}

function extractZip(zipPath, destination) {
  if (process.platform === 'win32') {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`;
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
  }
  return run('unzip', ['-q', '-o', zipPath, '-d', destination]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}`)));
  });
}

async function replaceOutputs(outputDir, replacements) {
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const backups = [];
  const installed = [];
  try {
    for (const replacement of replacements) {
      if (await exists(replacement.destination)) {
        const backup = path.join(outputDir, `.runtime-backup-${suffix}-${path.basename(replacement.destination)}`);
        await rename(replacement.destination, backup);
        backups.push({ backup, destination: replacement.destination });
      }
      await rename(replacement.source, replacement.destination);
      installed.push(replacement.destination);
    }
  } catch (error) {
    for (const destination of installed.reverse()) await rm(destination, { recursive: true, force: true });
    for (const backup of backups.reverse()) await rename(backup.backup, backup.destination);
    throw error;
  }
  await Promise.allSettled(backups.map(({ backup }) => rm(backup, { recursive: true, force: true })));
}

async function withLock(lockPath, work) {
  try {
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another runtime dependency preparation owns ${lockPath}.`);
    throw error;
  }
  try { return await work(); }
  finally { await rm(lockPath, { force: true }); }
}

async function readJson(target) {
  try { return JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function exists(target) {
  try { await stat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split('/').includes('..') && !value.includes('\\');
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function exactJson(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }

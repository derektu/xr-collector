#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedTargets = new Set(['darwin-arm64', 'win32-x64']);

/** Captures the source that a build actually consumes, independently of its destination name. */
export async function createBuildInfo(options, dependencies = {}) {
  const projectRoot = options.projectRoot ?? root;
  const environment = dependencies.environment ?? { platform: process.platform, arch: process.arch };
  const target = `${environment.platform}-${environment.arch}`;
  const packaged = options.kind === 'packaged';
  if (options.kind !== 'development' && !packaged) throw new Error('Build kind must be development or packaged.');
  if (packaged && (!packagedTargets.has(options.target) || options.target !== target)) {
    throw new Error(`Packaged target must match the executing Node platform/architecture (${target}).`);
  }
  if (options.variant !== undefined && options.variant !== 'chinese' && options.variant !== 'official') {
    throw new Error('Build variant must be chinese or official.');
  }
  if (packaged && !options.variant) throw new Error('A packaged build requires an explicit engine variant.');
  const packageInfo = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  if (typeof packageInfo.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/iu.test(packageInfo.version)) {
    throw new Error('The package version is missing or invalid.');
  }
  // Git environment routing must not point this source check at another checkout or index.
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const gitOptions = { cwd: projectRoot, env: gitEnvironment };
  let commit = null;
  let sourceDirty = null;
  try {
    // A Git-less source copy must not inherit an unrelated parent repository's identity.
    await lstat(path.join(projectRoot, '.git'));
    commit = (await exec('git', ['rev-parse', 'HEAD'], gitOptions)).stdout.trim();
    if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Git returned no full commit identity.');
    sourceDirty = (await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], gitOptions)).stdout.trim().length > 0;
  } catch (error) {
    if (packaged) throw new Error('A packaged build requires an actual clean Git checkout with a full commit identity.', { cause: error });
    commit = null;
    sourceDirty = null;
  }
  if (packaged && sourceDirty !== false) throw new Error('A packaged build requires an actual clean Git checkout.');
  let manifest = null;
  if (environment.platform === 'darwin' || environment.platform === 'win32') {
    const directory = environment.platform === 'win32' ? 'win' : 'mac';
    try { manifest = JSON.parse(await readFile(path.join(projectRoot, 'resources', 'bin', directory, 'meilisearch-build.json'), 'utf8')); }
    catch (error) {
      if (packaged) throw new Error('The prepared runtime manifest is required for a packaged build.', { cause: error });
    }
  }
  const variant = manifest?.distribution === 'official' ? 'official'
    : manifest?.distribution === undefined && JSON.stringify(manifest?.features) === JSON.stringify(['chinese']) ? 'chinese' : null;
  if (packaged && (manifest?.target !== options.target || variant !== options.variant)) {
    throw new Error('Prepared runtime target/variant does not match the packaged build.');
  }
  return {
    schemaVersion: 1,
    kind: options.kind,
    version: packageInfo.version,
    builtAt: new Date().toISOString(),
    commit,
    buildId: randomUUID(),
    target,
    variant: packaged ? options.variant : variant,
    sourceDirty,
  };
}

export async function writeBuildInfo(options, dependencies = {}) {
  const info = await createBuildInfo(options, dependencies);
  const output = path.join(options.projectRoot ?? root, 'dist', 'node', 'build-info.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

function argumentsOf(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--kind') options.kind = argv[++i];
    else if (argv[i] === '--target') options.target = argv[++i];
    else if (argv[i] === '--variant') options.variant = argv[++i];
    else throw new Error(`Unknown build information argument ${argv[i]}.`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeBuildInfo(argumentsOf(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

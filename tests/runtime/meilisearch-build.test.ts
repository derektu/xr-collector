import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The production build entry point is intentionally executable JavaScript.
import { assertControlledCargoConfiguration, buildMeilisearch, cleanBuildEnvironment, inspectExecutable, runCommand, selectTarget, transactionalReplacePair } from '../../scripts/build-meilisearch.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'xr-meili-build-'));
  roots.push(value);
  return value;
}

function machoArm64(): Buffer {
  const binary = Buffer.alloc(16);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  return binary;
}

function machoX64(): Buffer {
  const binary = Buffer.alloc(16);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x01000007, 4);
  return binary;
}

function harness() {
  let cargoBuilds = 0;
  let dirty = '';
  let version = 'meilisearch 1.53.2\n';
  let rustRelease = '1.91.1';
  let lockHash = 'f884034e00ae026ecc9a3c15999b11857dff4a99ba8d7c0528626571627cefbf';
  let builtBinary = machoArm64();
  const run = vi.fn(async (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    if (command === 'rustc') return { stdout: `rustc ${rustRelease}\nrelease: ${rustRelease}\nhost: aarch64-apple-darwin\n`, stderr: '' };
    if (command === 'cargo' && args.includes('-V')) return { stdout: 'cargo 1.91.1 (test)\n', stderr: '' };
    if (command === 'git' && args[0] === 'init') { await mkdir(path.join(options.cwd!, '.git')); return { stdout: '', stderr: '' }; }
    if (command === 'git' && args[0] === 'checkout') { await writeFile(path.join(options.cwd!, 'Cargo.lock'), 'fixture'); return { stdout: '', stderr: '' }; }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'ec006cecec6f684b1dcaee093a45ab4c05707127\n', stderr: '' };
    if (command === 'git' && args[0] === 'status') return { stdout: dirty, stderr: '' };
    if (command === 'git') return { stdout: '', stderr: '' };
    if (command === 'cargo') {
      cargoBuilds += 1;
      expect(args).toEqual(['+1.91.1', 'build', '--release', '--locked', '-p', 'meilisearch', '--no-default-features', '--features', 'chinese', '--target', 'aarch64-apple-darwin']);
      expect(options.env?.RUSTFLAGS).toBe('');
      expect(options.env?.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
      expect(Object.keys(options.env ?? {}).some((key) => key.startsWith('CARGO_PROFILE_'))).toBe(false);
      const output = path.join(options.env!.CARGO_TARGET_DIR!, 'aarch64-apple-darwin', 'release', 'meilisearch');
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, builtBinary);
      return { stdout: '', stderr: '' };
    }
    if (path.basename(command) === 'meilisearch') return { stdout: version, stderr: '' };
    if (command === 'sysctl') return { stdout: '0\n', stderr: '' };
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  });
  const hashFile = async (file: string) => path.basename(file) === 'Cargo.lock'
    ? lockHash
    : createHash('sha256').update(await readFile(file)).digest('hex');
  return {
    run, hashFile, builds: () => cargoBuilds,
    setDirty: (value: string) => { dirty = value; },
    setVersion: (value: string) => { version = value; },
    setRustRelease: (value: string) => { rustRelease = value; },
    setLockHash: (value: string) => { lockHash = value; },
    setBuiltBinary: (value: Buffer) => { builtBinary = value; },
  };
}

describe('pinned Meilisearch build', () => {
  it('rejects cross-target and emulated native claims', () => {
    expect(() => selectTarget('win32-x64', { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' })).toThrow(/cross compilation/u);
    expect(() => selectTarget('win32-x64', { platform: 'win32', processArch: 'x64', hostArch: 'arm64', requireNative: true })).toThrow(/native x64 runner/u);
    expect(selectTarget('win32-x64', { platform: 'win32', processArch: 'x64', hostArch: 'arm64' }).emulated).toBe(true);
  });

  it('recognizes only the expected native executable architecture', () => {
    expect(inspectExecutable(machoArm64())).toEqual({ format: 'Mach-O 64', arch: 'arm64' });
    expect(() => inspectExecutable(Buffer.from('not executable'))).toThrow(/unrecognized/u);
  });

  it('removes every inherited Cargo rustflags and profile override from the build environment', () => {
    expect(cleanBuildEnvironment('/target', {
      KEEP: 'yes', RUSTFLAGS: '-C old', CARGO_ENCODED_RUSTFLAGS: 'encoded', CARGO_BUILD_RUSTFLAGS: '-C build',
      CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS: '-C target', CARGO_PROFILE_RELEASE_LTO: 'false',
      rustFlags: '-C mixed', cargo_build_rustflags: '-C lowercase', Cargo_Profile_Release_Debug: 'true',
      cargo_target_x86_64_pc_windows_msvc_rustflags: '-C windows', cargo_target_dir: '/wrong-target',
      RUSTC: '/wrong/rustc', rustc_wrapper: '/wrong/wrapper', Rustc_Workspace_Wrapper: '/wrong/workspace-wrapper',
      cargo_build_rustc: '/wrong/cargo-rustc', CARGO_BUILD_RUSTC_WRAPPER: '/wrong/cargo-wrapper',
      cargo_build_rustc_workspace_wrapper: '/wrong/cargo-workspace-wrapper',
    })).toEqual({ KEEP: 'yes', RUSTFLAGS: '', CARGO_TARGET_DIR: '/target' });
  });

  it('propagates a streamed build command failure', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'inherit' })).rejects.toThrow(/code 7/u);
  });

  it('allows Cargo configuration pinned inside the verified source checkout', async () => {
    const at = await root();
    const source = path.join(at, 'source');
    await mkdir(path.join(source, '.cargo'), { recursive: true });
    await writeFile(path.join(source, '.cargo', 'config.toml'), '[build]\nrustflags = []\n');
    const tracked = vi.fn(async () => ({ stdout: '.cargo/config.toml\n', stderr: '' }));
    await expect(assertControlledCargoConfiguration(source, { CARGO_HOME: path.join(at, 'empty-cargo-home') }, tracked)).resolves.toBeUndefined();
    expect(tracked).toHaveBeenCalledWith('git', ['ls-files', '--error-unmatch', '--', '.cargo/config.toml'], { cwd: source });
  });

  it('rejects an ignored or otherwise untracked Cargo config inside the source checkout', async () => {
    const at = await root();
    const source = path.join(at, 'source');
    await mkdir(path.join(source, '.cargo'), { recursive: true });
    await writeFile(path.join(source, '.cargo', 'config.toml'), '[build]\nrustc = "/wrong/compiler"\n');
    await expect(assertControlledCargoConfiguration(
      source,
      { CARGO_HOME: path.join(at, 'empty-cargo-home') },
      async () => { throw new Error('not tracked'); },
    )).rejects.toThrow(/not tracked by the pinned source/u);
  });

  it('resolves a relative CARGO_HOME from Cargo cwd and rejects its external config', async () => {
    const at = await root();
    const source = path.join(at, 'work', 'source');
    const cargoHome = path.join(at, 'work', 'cargo-home');
    await mkdir(source, { recursive: true });
    await mkdir(cargoHome);
    await writeFile(path.join(cargoHome, 'config'), '[build]\nrustc = "/wrong/compiler"\n');
    await expect(assertControlledCargoConfiguration(source, { CARGO_HOME: '../cargo-home' })).rejects.toThrow(cargoHome);
  });

  it('fetches and builds once, then verifies and reuses the exact cache', async () => {
    const at = await root();
    const fake = harness();
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    const first = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    const second = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(fake.builds()).toBe(1);
    expect(fake.run).toHaveBeenCalledWith('git', ['config', '--local', 'core.autocrlf', 'false'], expect.objectContaining({ cwd: expect.any(String) }));
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toMatchObject({ target: 'darwin-arm64', sourceCommit: 'ec006cecec6f684b1dcaee093a45ab4c05707127', features: ['chinese'] });
  });

  it('enables repository-local long paths before upstream checkout and on cache reuse', async () => {
    const at = await root();
    const fake = harness();
    let longPaths = false;
    const run: typeof fake.run = vi.fn(async (command, args, options) => {
      if (command === 'git' && args.join(' ') === 'config --local core.longpaths true') longPaths = true;
      if (command === 'git' && args[0] === 'checkout' && !longPaths) throw new Error('Filename too long');
      return fake.run(command, args, options);
    });
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'nested', 'project', 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    const dependencies = { run, fileSha256: fake.hashFile };
    await expect(buildMeilisearch(options, dependencies)).resolves.toMatchObject({ cacheHit: false });
    longPaths = false;
    await expect(buildMeilisearch(options, dependencies)).resolves.toMatchObject({ cacheHit: true });
    expect(longPaths).toBe(true);
    expect(fake.builds()).toBe(1);
  });

  it('refuses a dirty source checkout without running Cargo or replacing runtime', async () => {
    const at = await root();
    const fake = harness();
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    const before = await readFile(path.join(at, 'runtime', 'meilisearch'));
    fake.setDirty('?? unexpected');
    await expect(buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile })).rejects.toThrow(/source cache is dirty/u);
    expect(await readFile(path.join(at, 'runtime', 'meilisearch'))).toEqual(before);
    expect(fake.builds()).toBe(1);
  });

  it('repairs a tampered installed manifest from a verified cache without rebuilding', async () => {
    const at = await root();
    const fake = harness();
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    const first = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    await writeFile(first.manifestPath, '{"tampered":true}\n');
    const second = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    expect(second.cacheHit).toBe(true);
    expect(fake.builds()).toBe(1);
    expect(JSON.parse(await readFile(second.manifestPath, 'utf8'))).toMatchObject({ sourceCommit: 'ec006cecec6f684b1dcaee093a45ab4c05707127' });
  });

  it('rebuilds when the cached output checksum changes', async () => {
    const at = await root();
    const fake = harness();
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    const first = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    const cachedBinary = path.join(first.entry, 'artifact', 'meilisearch');
    const tampered = await readFile(cachedBinary);
    tampered[12] = 1;
    await writeFile(cachedBinary, tampered);
    const second = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    expect(second.cacheHit).toBe(false);
    expect(fake.builds()).toBe(2);
  });

  it('rejects a cache manifest without a valid completion time', async () => {
    const at = await root();
    const fake = harness();
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    const first = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    const cachedManifest = path.join(first.entry, 'artifact', 'meilisearch-build.json');
    const value = JSON.parse(await readFile(cachedManifest, 'utf8')) as Record<string, unknown>;
    value.completedAt = 'not-a-date';
    await writeFile(cachedManifest, JSON.stringify(value));
    const second = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    expect(second.cacheHit).toBe(false);
    expect(fake.builds()).toBe(2);
  });

  it('rejects the wrong Rust release and Cargo.lock before Cargo can build', async () => {
    const at = await root();
    const wrongRust = harness();
    wrongRust.setRustRelease('1.90.0');
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'rust-cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    await expect(buildMeilisearch(options, { run: wrongRust.run, fileSha256: wrongRust.hashFile })).rejects.toThrow(/Rust 1\.91\.1/u);
    expect(wrongRust.builds()).toBe(0);

    const wrongLock = harness();
    wrongLock.setLockHash('0'.repeat(64));
    await expect(buildMeilisearch({ ...options, cacheRoot: path.join(at, 'lock-cache') }, { run: wrongLock.run, fileSha256: wrongLock.hashFile })).rejects.toThrow(/Cargo\.lock checksum/u);
    expect(wrongLock.builds()).toBe(0);
  });

  it('preserves the installed pair when a rebuilt executable reports the wrong version', async () => {
    const at = await root();
    const fake = harness();
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    const first = await buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile });
    const oldBinary = await readFile(first.binaryPath);
    const oldManifest = await readFile(first.manifestPath);
    await rm(path.join(first.entry, 'artifact'), { recursive: true });
    fake.setVersion('meilisearch 9.9.9\n');
    await expect(buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile })).rejects.toThrow(/expected meilisearch 1\.53\.2/u);
    expect(await readFile(first.binaryPath)).toEqual(oldBinary);
    expect(await readFile(first.manifestPath)).toEqual(oldManifest);
  });

  it('does not fall back to an installed runtime when the exact source fetch fails', async () => {
    const at = await root();
    const fake = harness();
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), '{"old":true}\n');
    const failingRun = vi.fn(async (command: string, args: string[], options = {}) => {
      if (command === 'git' && args[0] === 'fetch') throw new Error('offline');
      return fake.run(command, args, options);
    });
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot, environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    await expect(buildMeilisearch(options, { run: failingRun, fileSha256: fake.hashFile })).rejects.toThrow('offline');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('{"old":true}\n');
  });

  it('rejects external Cargo compiler configuration and preserves the installed pair', async () => {
    const at = await root();
    const fake = harness();
    const runtimeRoot = path.join(at, 'runtime');
    const cargoHome = path.join(at, 'external-cargo-home');
    await mkdir(runtimeRoot);
    await mkdir(cargoHome);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    await writeFile(path.join(cargoHome, 'config.toml'), '[build]\nrustc = "/wrong/compiler"\n');
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot, environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    await expect(buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile, inheritedEnvironment: { CARGO_HOME: cargoHome } })).rejects.toThrow(new RegExp(cargoHome.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    expect(fake.builds()).toBe(0);
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it.each([
    ['checkout', (command: string, args: string[]) => command === 'git' && args[0] === 'checkout'],
    ['Cargo build', (command: string, args: string[]) => command === 'cargo' && args.includes('build')],
  ])('preserves the installed pair when %s fails', async (_label, shouldFail) => {
    const at = await root();
    const fake = harness();
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    const failingRun = vi.fn(async (command: string, args: string[], options = {}) => {
      if (shouldFail(command, args)) throw new Error('injected build step failure');
      return fake.run(command, args, options);
    });
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot, environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    await expect(buildMeilisearch(options, { run: failingRun, fileSha256: fake.hashFile })).rejects.toThrow(/injected build step/u);
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it('preserves the installed pair when Cargo produces another architecture', async () => {
    const at = await root();
    const fake = harness();
    fake.setBuiltBinary(machoX64());
    const runtimeRoot = path.join(at, 'runtime');
    await mkdir(runtimeRoot);
    await writeFile(path.join(runtimeRoot, 'meilisearch'), 'old-binary');
    await writeFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'old-manifest');
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot, environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    await expect(buildMeilisearch(options, { run: fake.run, fileSha256: fake.hashFile })).rejects.toThrow(/architecture x64 does not match arm64/u);
    expect(await readFile(path.join(runtimeRoot, 'meilisearch'), 'utf8')).toBe('old-binary');
    expect(await readFile(path.join(runtimeRoot, 'meilisearch-build.json'), 'utf8')).toBe('old-manifest');
  });

  it('refuses a concurrent writer for the same recipe and target cache', async () => {
    const at = await root();
    const fake = harness();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cargoEntered = new Promise<void>((resolve) => { entered = resolve; });
    let held = false;
    const gatedRun = vi.fn(async (command: string, args: string[], options = {}) => {
      if (command === 'cargo' && args.includes('build') && !held) {
        held = true;
        entered();
        await gate;
      }
      return fake.run(command, args, options);
    });
    const options = { target: 'darwin-arm64', cacheRoot: path.join(at, 'cache'), runtimeRoot: path.join(at, 'runtime'), environment: { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64' } };
    const first = buildMeilisearch(options, { run: gatedRun, fileSha256: fake.hashFile });
    await cargoEntered;
    await expect(buildMeilisearch(options, { run: gatedRun, fileSha256: fake.hashFile })).rejects.toThrow(/Another Meilisearch build owns/u);
    release();
    await expect(first).resolves.toMatchObject({ cacheHit: false });
  });

  it('rolls both runtime files back when replacement fails between the pair', async () => {
    const at = await root();
    const binary = path.join(at, 'source');
    const destination = path.join(at, 'runtime', 'meilisearch');
    const manifest = path.join(at, 'runtime', 'meilisearch-build.json');
    await mkdir(path.dirname(destination));
    await writeFile(binary, 'new');
    await writeFile(destination, 'old');
    await writeFile(manifest, '{"old":true}\n');
    await expect(transactionalReplacePair({
      binarySource: binary,
      manifest: { next: true },
      binaryDestination: destination,
      manifestDestination: manifest,
      fault: async (phase: string) => { if (phase === 'binary-installed') throw new Error('injected rename failure'); },
    })).rejects.toThrow(/injected/u);
    expect(await readFile(destination, 'utf8')).toBe('old');
    expect(await readFile(manifest, 'utf8')).toBe('{"old":true}\n');
  });

  it('preserves backup files and reports their paths when rollback cannot restore them', async () => {
    const at = await root();
    const binary = path.join(at, 'source');
    const runtime = path.join(at, 'runtime');
    const destination = path.join(runtime, 'meilisearch');
    const manifest = path.join(runtime, 'meilisearch-build.json');
    await mkdir(runtime);
    await writeFile(binary, 'new');
    await writeFile(destination, 'old-binary');
    await writeFile(manifest, 'old-manifest');
    const move = async (source: string, target: string) => {
      if (source.endsWith('.bak')) throw new Error('injected restore failure');
      await rename(source, target);
    };
    await expect(transactionalReplacePair({
      binarySource: binary, manifest: { next: true }, binaryDestination: destination, manifestDestination: manifest,
      fault: async (phase: string) => { if (phase === 'binary-installed') throw new Error('injected install failure'); },
      move,
    })).rejects.toThrow(/rollback was incomplete.*\.bak/u);
    const backups = (await readdir(runtime)).filter((name) => name.endsWith('.bak'));
    expect(backups).toHaveLength(2);
    expect(await Promise.all(backups.map((name) => readFile(path.join(runtime, name), 'utf8')))).toEqual(expect.arrayContaining(['old-binary', 'old-manifest']));
  });

  it('keeps a fully committed pair when deleting its old backups fails', async () => {
    const at = await root();
    const binary = path.join(at, 'source');
    const runtime = path.join(at, 'runtime');
    const destination = path.join(runtime, 'meilisearch');
    const manifest = path.join(runtime, 'meilisearch-build.json');
    await mkdir(runtime);
    await writeFile(binary, 'new');
    await writeFile(destination, 'old-binary');
    await writeFile(manifest, 'old-manifest');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const remove = async (target: string, options: { force?: boolean }) => {
      if (target.endsWith('.bak')) throw new Error('injected cleanup failure');
      await rm(target, options);
    };
    await expect(transactionalReplacePair({ binarySource: binary, manifest: { next: true }, binaryDestination: destination, manifestDestination: manifest, remove })).resolves.toBeUndefined();
    expect(await readFile(destination, 'utf8')).toBe('new');
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual({ next: true });
    expect((await readdir(runtime)).filter((name) => name.endsWith('.bak'))).toHaveLength(2);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});

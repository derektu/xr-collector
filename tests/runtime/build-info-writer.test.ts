import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node build producer is an executable JavaScript seam.
import { createBuildInfo, writeBuildInfo } from '../../scripts/write-build-info.mjs';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-build-info-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'xr-collector', version: '0.7.0' }));
  await writeFile(path.join(root, '.gitignore'), 'dist/\nresources/bin/\n');
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root });
  await mkdir(path.join(root, 'resources', 'bin', 'mac'), { recursive: true });
  await writeFile(path.join(root, 'resources', 'bin', 'mac', 'meilisearch-build.json'), JSON.stringify({ target: 'darwin-arm64', features: ['chinese'] }));
  return root;
}

describe('build information producer', () => {
  it('writes the actual clean Git commit and package version for the selected packaged artifact', async () => {
    const root = await fixture();
    const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await writeBuildInfo({ projectRoot: root, kind: 'packaged', target: 'darwin-arm64', variant: 'chinese' }, { environment: { platform: 'darwin', arch: 'arm64' } });
    const info = JSON.parse(await readFile(path.join(root, 'dist', 'node', 'build-info.json'), 'utf8'));
    expect(info).toMatchObject({ schemaVersion: 1, kind: 'packaged', version: '0.7.0', commit, target: 'darwin-arm64', variant: 'chinese', sourceDirty: false });
    expect(new Date(info.builtAt).toISOString()).toBe(info.builtAt);
    expect(info.buildId).toMatch(/^[a-f0-9-]{36}$/u);
  });
  it('refuses dirty packaged sources without overwriting a previous identity', async () => {
    const root = await fixture();
    await writeBuildInfo({ projectRoot: root, kind: 'development' });
    const before = await readFile(path.join(root, 'dist', 'node', 'build-info.json'), 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'xr-collector', version: '0.8.0' }));
    await expect(writeBuildInfo({ projectRoot: root, kind: 'packaged', target: 'darwin-arm64', variant: 'chinese' },
      { environment: { platform: 'darwin', arch: 'arm64' } })).rejects.toThrow(/clean Git/u);
    expect(await readFile(path.join(root, 'dist', 'node', 'build-info.json'), 'utf8')).toBe(before);
    expect(await createBuildInfo({ projectRoot: root, kind: 'development' })).toMatchObject({ sourceDirty: true });
  });

  it('cannot claim a dirty source is clean through another repository in Git environment overrides', async () => {
    const root = await fixture();
    const other = await fixture();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'xr-collector', version: '0.8.0' }));
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    await expect(createBuildInfo({ projectRoot: root, kind: 'packaged', target: 'darwin-arm64', variant: 'chinese' },
      { environment: { platform: 'darwin', arch: 'arm64' } })).rejects.toThrow(/clean Git/u);
  });

  it('does not borrow a parent repository identity for a Git-less copy', async () => {
    const parent = await fixture();
    const root = path.join(parent, 'dist', 'copy');
    await mkdir(path.join(root, 'resources', 'bin', 'mac'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'xr-collector', version: '0.8.0' }));
    await writeFile(path.join(root, 'resources', 'bin', 'mac', 'meilisearch-build.json'), JSON.stringify({ target: 'darwin-arm64', features: ['chinese'] }));
    await expect(createBuildInfo({ projectRoot: root, kind: 'packaged', target: 'darwin-arm64', variant: 'chinese' },
      { environment: { platform: 'darwin', arch: 'arm64' } })).rejects.toThrow(/actual clean Git/u);
    expect(await createBuildInfo({ projectRoot: root, kind: 'development' })).toMatchObject({ commit: null, sourceDirty: null });
  });

  it('uses unknown source identity for a Git-less development copy and rejects packaging it', async () => {
    const root = await fixture();
    await rm(path.join(root, '.git'), { recursive: true });
    expect(await createBuildInfo({ projectRoot: root, kind: 'development' }, { environment: { platform: 'linux', arch: 'x64' } }))
      .toMatchObject({ kind: 'development', version: '0.7.0', commit: null, sourceDirty: null, target: 'linux-x64', variant: null });
    await expect(createBuildInfo({ projectRoot: root, kind: 'packaged', target: 'darwin-arm64', variant: 'chinese' },
      { environment: { platform: 'darwin', arch: 'arm64' } })).rejects.toThrow(/actual clean Git/u);
  });

  it('rejects runtime target/variant mismatch and emits distinguishable build identifiers', async () => {
    const root = await fixture();
    const options = { projectRoot: root, kind: 'packaged', target: 'darwin-arm64', variant: 'chinese' };
    const environment = { platform: 'darwin', arch: 'arm64' };
    await expect(createBuildInfo({ ...options, variant: 'official' }, { environment })).rejects.toThrow(/runtime target\/variant/u);
    await expect(createBuildInfo({ ...options, target: 'win32-x64' }, { environment })).rejects.toThrow(/executing Node/u);
    const first = await createBuildInfo(options, { environment });
    const second = await createBuildInfo(options, { environment });
    expect(first.buildId).not.toBe(second.buildId);
    await writeFile(path.join(root, 'resources', 'bin', 'mac', 'meilisearch-build.json'), JSON.stringify({ distribution: 'official', target: 'darwin-arm64' }));
    expect(await createBuildInfo({ ...options, variant: 'official' }, { environment })).toMatchObject({ variant: 'official', commit: first.commit });
  });
});

import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBuildInfo, validateBuildInfo } from '../../src/runtime/build-info.js';

const artifact = {
  schemaVersion: 1, kind: 'packaged', version: '0.7.0', builtAt: '2026-10-25T09:00:00.000Z',
  commit: '1234567890123456789012345678901234567890', buildId: 'fixture-build',
  target: 'darwin-arm64', variant: 'chinese', sourceDirty: false,
};
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => { vi.clearAllMocks(); });
const environment = { requirePackaged: true, platform: 'darwin' as const, arch: 'arm64' };

describe('serialized build identity', () => {
  it('accepts the matching packaged identity and returns an immutable snapshot', () => {
    const source = { ...artifact };
    const info = validateBuildInfo(source, environment);
    source.version = '9.9.9';
    expect(info.version).toBe('0.7.0');
    expect(Object.isFrozen(info)).toBe(true);
  });

  it.each([
    { sourceDirty: true }, { commit: null, sourceDirty: null }, { target: 'win32-x64' },
    { kind: 'development' }, { variant: null }, { builtAt: 'yesterday' }, { commit: 'short' },
  ])('rejects a packaged identity with invalid provenance %j', (change) => {
    expect(() => validateBuildInfo({ ...artifact, ...change }, environment)).toThrow(/valid application artifact/u);
  });

  it('preserves unknown development provenance without describing it as clean', () => {
    const development = { ...artifact, kind: 'development', target: 'linux-x64', commit: null, sourceDirty: null, variant: null };
    expect(validateBuildInfo(development)).toMatchObject({ kind: 'development', commit: null, sourceDirty: null });
    expect(() => validateBuildInfo({ ...development, sourceDirty: false })).toThrow();
  });

  it('refuses a packaged artifact identity in a development launch instead of displaying it as clean', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(artifact));
    await expect(loadBuildInfo({ packaged: false })).rejects.toThrow(/Packaged build information cannot identify a development launch/u);
  });

  it('never falls back to source Git for an installed App missing its generated identity', async () => {
    await expect(loadBuildInfo({ packaged: true })).rejects.toThrow(/missing or invalid/u);
  });
});

// Broken, opening the Vault in use under another letter case starts a switch to itself, or exports and backups go to the wrong folder.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { backupFolder, exportFolder, isSameFolder } from '../../../src/domain/vault/transfer-files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function caseInsensitive(root: string): Promise<boolean> {
  await mkdir(path.join(root, 'Probe'));
  return stat(path.join(root, 'probe')).then(() => true, () => false);
}

it('treats another spelling of a folder as the same folder on a case-insensitive volume, since realpath returns the spelling on disk', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-same-'));
  roots.push(root);
  if (!await caseInsensitive(root)) context.skip();
  await mkdir(path.join(root, 'Vault'));

  await mkdir(path.join(root, 'Other'));

  expect(await isSameFolder(path.join(root, 'VAULT'), path.join(root, 'vault'))).toBe(true);
  expect(await isSameFolder(path.join(root, 'Other'), path.join(root, 'Vault'))).toBe(false);
});

it.each([
  ['export', 'XR_COLLECTOR_EXPORT_DIR', exportFolder, 'XR Collector 匯出'],
  ['backup', 'XR_COLLECTOR_BACKUP_DIR', backupFolder, 'XR Collector 備份'],
] as const)('puts the %s folder in Documents on each platform unless %s names another', (_kind, variable, folder, name) => {
  vi.stubEnv(variable, '');
  try {
    expect(folder('C:\\Users\\me\\Documents', path.win32)).toBe(`C:\\Users\\me\\Documents\\${name}`);
    expect(folder('/Users/me/Documents', path.posix)).toBe(`/Users/me/Documents/${name}`);
    vi.stubEnv(variable, '/tmp/xr-folder');
    expect(folder('/Users/me/Documents')).toBe(path.resolve('/tmp/xr-folder'));
  } finally { vi.unstubAllEnvs(); }
});

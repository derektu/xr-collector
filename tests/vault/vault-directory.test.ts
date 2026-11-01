import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultDirectory, inspectVaultDirectory, VAULT_MARKER, writeVaultMarker } from '../../src/vault/vault-directory.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-vault-directory-'));
  roots.push(root);
  return root;
}
async function vault(root: string, documents = 0): Promise<string> {
  await mkdir(path.join(root, 'documents', 'youtube'), { recursive: true });
  await writeVaultMarker(root, 'XR Collector test');
  for (let index = 0; index < documents; index += 1) {
    await writeFile(path.join(root, 'documents', 'youtube', `video${index}.md`), '---\n---\n');
  }
  return root;
}

describe('inspectVaultDirectory', () => {
  it('treats empty, system-file-only and creatable missing directories as empty', async () => {
    const root = await temp();
    expect(await inspectVaultDirectory(root)).toEqual({ kind: 'empty', path: root, exists: true });
    await writeFile(path.join(root, '.DS_Store'), '');
    await writeFile(path.join(root, 'desktop.ini'), '');
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'empty', exists: true });
    expect(await inspectVaultDirectory(path.join(root, 'new'))).toEqual({ kind: 'empty', path: path.join(root, 'new'), exists: false });
  });

  it('recognizes a marked Vault and counts its documents', async () => {
    const root = await vault(await temp(), 2);
    expect(await inspectVaultDirectory(root)).toEqual({ kind: 'existing', path: root, documentCount: 2 });
  });

  it.each([
    ['a relative path', async () => 'relative/vault', '絕對路徑'],
    ['a missing parent', async (root: string) => path.join(root, 'missing', 'vault'), '上層目錄也不存在'],
    ['a file', async (root: string) => { const file = path.join(root, 'file'); await writeFile(file, ''); return file; }, '不是目錄'],
    ['unrecognized content', async (root: string) => { await writeFile(path.join(root, 'notes.txt'), 'x'); return root; }, '」不是 XR Collector 知識庫。'],
    ['a directory with only the first-round layout', async (root: string) => { await mkdir(path.join(root, 'documents', 'youtube'), { recursive: true }); return root; }, '不是 XR Collector 知識庫'],
    ['a malformed marker', async (root: string) => { await writeFile(path.join(root, VAULT_MARKER), '{'); return root; }, '標記檔格式錯誤'],
    ['a foreign marker', async (root: string) => { await writeFile(path.join(root, VAULT_MARKER), '{"format":"other","formatVersion":1}'); return root; }, '標記檔格式錯誤'],
    ['a newer format', async (root: string) => { await writeFile(path.join(root, VAULT_MARKER), '{"format":"xr-collector-vault","formatVersion":3}'); return root; }, '較新版本'],
    ['broken settings', async (root: string) => { await vault(root); await mkdir(path.join(root, 'settings')); await writeFile(path.join(root, 'settings', 'youtube-channels.json'), '{'); return root; }, 'youtube-channels.json 格式錯誤'],
  ])('rejects %s without changing it', async (_label, prepare, reason) => {
    const root = await temp();
    const target = await prepare(root);
    const before = await readdir(root, { recursive: true });
    expect(await inspectVaultDirectory(target)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining(reason) });
    expect(await readdir(root, { recursive: true })).toEqual(before);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an unreadable directory', async () => {
    const root = await vault(await temp());
    await chmod(root, 0o000);
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('沒有權限') });
  });
});

describe('createVaultDirectory', () => {
  it('creates a missing directory with a self-contained marker', async () => {
    const root = path.join(await temp(), 'XR Collector');
    expect(await createVaultDirectory(root, 'XR Collector 9.9.9')).toBe(root);
    const marker = JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8'));
    expect(marker).toEqual({
      format: 'xr-collector-vault', formatVersion: 1, createdBy: 'XR Collector 9.9.9',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u),
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
    });
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'existing', documentCount: 0 });
  });

  it('refuses existing Vaults and non-empty directories', async () => {
    const existing = await vault(await temp());
    await expect(createVaultDirectory(existing, 'test')).rejects.toMatchObject({ code: 'vault_invalid', message: expect.stringContaining('改用開啟') });
    const other = await temp();
    await writeFile(path.join(other, 'notes.txt'), 'x');
    await expect(createVaultDirectory(other, 'test')).rejects.toMatchObject({ code: 'vault_invalid' });
    expect(await readdir(other)).toEqual(['notes.txt']);
  });
});

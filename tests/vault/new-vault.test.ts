import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkNewVault, createNewVault, describePackage, nameProblem } from '../../src/vault/new-vault.js';
import { inspectVaultDirectory, VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { packageOf } from './package-fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-new-vault-'));
  roots.push(root);
  return root;
}

describe('nameProblem', () => {
  it('accepts names that both desktop platforms keep', () => {
    for (const name of ['XR Collector', '研究資料', 'Vault.v2', 'a']) expect(nameProblem(name), name).toBeNull();
  });

  it('refuses names that are empty or cannot name a folder on macOS or Windows', () => {
    expect(nameProblem('')).toBe('請輸入名稱。');
    expect(nameProblem('   ')).toBe('請輸入名稱。');
    for (const name of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b']) {
      expect(nameProblem(name), name).toContain('不能包含');
    }
    expect(nameProblem(' XR')).toBe('名稱的開頭和結尾不能是空白。');
    expect(nameProblem('XR ')).toBe('名稱的開頭和結尾不能是空白。');
    expect(nameProblem('.hidden')).toBe('名稱不能以句點開頭。');
    expect(nameProblem('..')).toBe('名稱不能以句點開頭。');
    expect(nameProblem('Vault.')).toBe('名稱不能以句點結尾。');
    expect(nameProblem('con')).toBe('「con」是系統保留的名稱，請換個名稱。');
    expect(nameProblem('LPT1.txt')).toContain('系統保留');
    expect(nameProblem('知'.repeat(86))).toBe('名稱太長。');
  });
});

describe('checkNewVault', () => {
  it('names the folder it would create when the location exists and the name is free', async () => {
    const parent = await temp();
    expect(await checkNewVault(parent, 'XR Collector')).toEqual({ path: path.join(parent, 'XR Collector'), problem: null });
  });

  it('refuses a name a file or folder in the location already has', async () => {
    const parent = await temp();
    await mkdir(path.join(parent, 'XR Collector'));
    await writeFile(path.join(parent, 'notes'), '');
    expect(await checkNewVault(parent, 'XR Collector')).toEqual({
      path: path.join(parent, 'XR Collector'), problem: '這個位置已經有「XR Collector」，請換個名稱。',
    });
    expect((await checkNewVault(parent, 'notes')).problem).toBe('這個位置已經有「notes」，請換個名稱。');
    expect((await checkNewVault(parent, 'Other')).problem).toBeNull();
  });

  it('refuses a missing, relative or file location and an invalid name', async () => {
    const parent = await temp();
    await writeFile(path.join(parent, 'file'), '');
    expect((await checkNewVault(path.join(parent, 'missing'), 'XR')).problem).toBe('找不到這個位置。');
    expect((await checkNewVault(path.join(parent, 'file'), 'XR')).problem).toBe('位置不是資料夾。');
    expect(await checkNewVault('relative/folder', 'XR')).toEqual({ path: null, problem: '位置必須是完整的絕對路徑。' });
    expect(await checkNewVault('', 'XR')).toEqual({ path: null, problem: '請選擇位置。' });
    expect(await checkNewVault(parent, 'a/b')).toEqual({ path: null, problem: '名稱不能包含 \\ / : * ? " < > | 等字元。' });
    expect(await checkNewVault(parent, 42)).toEqual({ path: null, problem: '請輸入名稱。' });
    const work = 'XR.importing-00000000-0000-4000-8000-000000000000';
    expect(await checkNewVault(parent, work)).toEqual({ path: path.join(parent, work), problem: '這是匯入使用的暫存資料夾名稱，請換個名稱。' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a location it cannot write', async () => {
    const parent = await temp();
    await chmod(parent, 0o500);
    expect((await checkNewVault(parent, 'XR')).problem).toBe('沒有權限在這個位置建立資料夾。');
  });
});

describe('createNewVault', () => {
  it('creates the named folder as an empty Vault and leaves the location otherwise as it was', async () => {
    const parent = await temp();
    await mkdir(path.join(parent, 'Other'));
    const root = await createNewVault(parent, 'XR Collector', 'XR Collector test');
    expect(root).toBe(path.join(parent, 'XR Collector'));
    expect(await readdir(root)).toEqual([VAULT_MARKER]);
    expect(JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8'))).toMatchObject({ createdBy: 'XR Collector test' });
    expect(await inspectVaultDirectory(root)).toEqual({ kind: 'existing', path: root, documentCount: 0 });
    expect((await readdir(parent)).sort()).toEqual(['Other', 'XR Collector']);
  });

  it('never creates a Vault in an existing folder, even an empty one', async () => {
    const parent = await temp();
    await mkdir(path.join(parent, 'XR Collector'));
    await expect(createNewVault(parent, 'XR Collector', 'test')).rejects.toMatchObject({
      code: 'vault_invalid', message: '這個位置已經有「XR Collector」，請換個名稱。',
    });
    expect(await readdir(path.join(parent, 'XR Collector'))).toEqual([]);
  });
});

describe('describePackage', () => {
  it('reads the date, counts and folder name an export file records', async () => {
    const folder = await temp();
    const file = path.join(folder, 'XR-A-2026-10-30.zip');
    await writeFile(file, await packageOf([], {
      exportedAt: '2026-10-30T02:00:00.000Z',
      source: { vaultId: '00000000-0000-4000-8000-000000000000', machine: 'A', folderName: 'XR-A' },
      summary: { documents: 128, subscriptions: 6, deletions: 0 },
    }));
    expect(await describePackage(file)).toEqual({
      path: file, fileName: 'XR-A-2026-10-30.zip', exportedAt: '2026-10-30T02:00:00.000Z', documents: 128, subscriptions: 6, folderName: 'XR-A',
    });
  });

  it('starts with the default name when the recorded folder name cannot name a folder', async () => {
    const folder = await temp();
    const file = path.join(folder, 'export.zip');
    await writeFile(file, await packageOf([], { source: { vaultId: '00000000-0000-4000-8000-000000000000', machine: 'A', folderName: 'a:b' } }));
    expect(await describePackage(file)).toMatchObject({ folderName: 'XR Collector', exportedAt: null, documents: 0, subscriptions: 0 });
  });

  it('refuses a file that is no export', async () => {
    const folder = await temp();
    const file = path.join(folder, 'other.zip');
    await writeFile(file, 'not a zip');
    await expect(describePackage(file)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(describePackage(path.join(folder, 'missing.zip'))).rejects.toMatchObject({ message: '找不到這個匯出檔。' });
  });
});

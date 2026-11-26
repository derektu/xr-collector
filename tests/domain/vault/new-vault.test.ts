// Broken, a new Vault lands where macOS or Windows cannot use it, or over data already there.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceVaults } from '../../../src/domain/vault/index.js';
import { checkNewVault, createNewVault, describePackage, nameProblem } from '../../../src/domain/vault/new-vault.js';
import { inspectVaultDirectory, VAULT_MARKER } from '../../../src/domain/vault/vault-directory.js';
import { packageOf } from '../../support/package-fixtures.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

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

const UNPROTECTED = { vaultRoot: null, profilePath: path.join(tmpdir(), 'xr-new-vault-no-profile') };

const RESERVED = '系統保留';
describe('nameProblem', () => {
  it.each<[string, string | null]>([
    ['XR Collector', null], ['研究資料', null], ['Vault.v2', null], ['a', null],
    ['', '請輸入名稱。'], ['   ', '請輸入名稱。'],
    ...['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b'].map((name) => [name, '不能包含'] as [string, string]),
    [' XR', '名稱的開頭和結尾不能是空白。'], ['XR ', '名稱的開頭和結尾不能是空白。'],
    ['.hidden', '名稱不能以句點開頭。'], ['..', '名稱不能以句點開頭。'], ['Vault.', '名稱不能以句點結尾。'],
    ['con', '「con」是系統保留的名稱，請換個名稱。'], ['LPT1.txt', RESERVED], ['COM4', RESERVED], ['lpt9.log', RESERVED],
    // External: Windows reserves COM and LPT followed by a superscript 1, 2 or 3 like COM1 to COM9
    // (https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
    ...['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³', 'com²', 'Lpt³', 'COM¹.txt', 'lpt².tar.gz'].map((name) => [name, RESERVED] as [string, string]),
    ['COM⁴', null], ['COM0', null], ['COM¹0', null], ['XCOM¹', null],
    ['知'.repeat(86), '名稱太長。'],
  ])('answers %j with %j, so the folder can exist on both macOS and Windows', (name, problem) => {
    if (problem === null) expect(nameProblem(name)).toBeNull();
    else expect(nameProblem(name)).toContain(problem);
  });
});

describe('checkNewVault', () => {
  it.each<[string, (parent: string) => Promise<[unknown, unknown]>, (parent: string) => { path: string | null; problem: string | null }]>([
    ['a free name in an existing location', async (parent) => [parent, 'XR Collector'], (parent) => ({ path: path.join(parent, 'XR Collector'), problem: null })],
    ['a name a folder in the location has', async (parent) => { await mkdir(path.join(parent, 'XR Collector')); return [parent, 'XR Collector']; },
      (parent) => ({ path: path.join(parent, 'XR Collector'), problem: '這個位置已經有「XR Collector」，請換個名稱。' })],
    ['a name a file in the location has', async (parent) => { await writeFile(path.join(parent, 'notes'), ''); return [parent, 'notes']; },
      (parent) => ({ path: path.join(parent, 'notes'), problem: '這個位置已經有「notes」，請換個名稱。' })],
    ['a missing location', async (parent) => [path.join(parent, 'missing'), 'XR'], (parent) => ({ path: path.join(parent, 'missing', 'XR'), problem: '找不到這個位置。' })],
    ['a file as location', async (parent) => { await writeFile(path.join(parent, 'file'), ''); return [path.join(parent, 'file'), 'XR']; },
      (parent) => ({ path: path.join(parent, 'file', 'XR'), problem: '位置不是資料夾。' })],
    ['a relative location', async () => ['relative/folder', 'XR'], () => ({ path: null, problem: '位置必須是完整的絕對路徑。' })],
    ['no location', async () => ['', 'XR'], () => ({ path: null, problem: '請選擇位置。' })],
    ['an invalid name', async (parent) => [parent, 'a/b'], () => ({ path: null, problem: '名稱不能包含 \\ / : * ? " < > | 等字元。' })],
    ['a name that is no text', async (parent) => [parent, 42], () => ({ path: null, problem: '請輸入名稱。' })],
  ])('checks %s', async (_label, prepare, expected) => {
    const parent = await temp();
    const [location, name] = await prepare(parent);
    expect(await checkNewVault(location, name, UNPROTECTED)).toEqual(expected(parent));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a location it cannot write', async () => {
    const parent = await temp();
    await chmod(parent, 0o500);
    expect((await checkNewVault(parent, 'XR', UNPROTECTED)).problem).toBe('沒有權限在這個位置建立資料夾。');
  });
});

describe('DeviceVaults.checkNew location', () => {
  const INSIDE_VAULT = '不能建立在目前的知識庫裡。';
  const INSIDE_PROFILE = '不能建立在程式資料目錄裡。';

  async function device() {
    const root = await temp();
    const vault = path.join(root, 'Vault');
    const profile = path.join(root, 'profile');
    for (const folder of [path.join(vault, 'notes'), path.join(profile, 'cache'), path.join(root, 'Other')]) await mkdir(folder, { recursive: true });
    return { root, vault, profile, vaults: new DeviceVaults({ profilePath: profile, sources: PRODUCT_SOURCES, createdBy: 'test' }) };
  }

  it.each<[string, string | null, (at: { root: string; vault: string; profile: string }) => [string, string | null]]>([
    ['a folder inside the Vault in use', INSIDE_VAULT, ({ vault }) => [path.join(vault, 'notes'), vault]],
    ['the Vault in use itself', INSIDE_VAULT, ({ vault }) => [vault, vault]],
    ['the program data directory', INSIDE_PROFILE, ({ vault, profile }) => [profile, vault]],
    ['a folder inside the program data directory, with no Vault in use', INSIDE_PROFILE, ({ profile }) => [path.join(profile, 'cache'), null]],
    ['the folder beside the Vault in use', null, ({ root, vault }) => [root, vault]],
    ['a sibling folder of the Vault in use', null, ({ root, vault }) => [path.join(root, 'Other'), vault]],
    ['a folder inside some Vault while none is in use', null, ({ vault }) => [path.join(vault, 'notes'), null]],
  ])('answers %s with %j, so deleting or moving one folder never takes another Vault with it', async (_label, problem, pick) => {
    const { vaults, ...at } = await device();
    const [location, vaultRoot] = pick(at);
    expect((await vaults.checkNew(location, 'New', vaultRoot)).problem).toBe(problem);
  });

  it('refuses another spelling of the Vault in use on a case-insensitive volume, since realpath returns the spelling on disk', async (context) => {
    const { root, vault, vaults } = await device();
    if (!await stat(path.join(root, 'vault')).then(() => true, () => false)) context.skip();
    expect((await vaults.checkNew(path.join(root, 'VAULT', 'NOTES'), 'New', vault)).problem).toBe(INSIDE_VAULT);
  });
});

describe('createNewVault', () => {
  it('creates the named folder as an empty Vault and leaves the location otherwise as it was', async () => {
    const parent = await temp();
    await mkdir(path.join(parent, 'Other'));
    const root = await createNewVault(parent, 'XR Collector', 'XR Collector test', UNPROTECTED);
    expect(root).toBe(path.join(parent, 'XR Collector'));
    expect(await readdir(root)).toEqual([VAULT_MARKER]);
    expect(JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8'))).toMatchObject({ createdBy: 'XR Collector test' });
    expect(await inspectVaultDirectory(root, PRODUCT_SOURCES)).toEqual({ kind: 'existing', path: root, documentCount: 0 });
    expect((await readdir(parent)).sort()).toEqual(['Other', 'XR Collector']);
  });

  it('never creates a Vault in an existing folder, even an empty one', async () => {
    const parent = await temp();
    await mkdir(path.join(parent, 'XR Collector'));
    await expect(createNewVault(parent, 'XR Collector', 'test', UNPROTECTED)).rejects.toMatchObject({
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
    expect(await describePackage(file, PRODUCT_SOURCES)).toEqual({
      path: file, fileName: 'XR-A-2026-10-30.zip', exportedAt: '2026-10-30T02:00:00.000Z', documents: 128, subscriptions: 6, folderName: 'XR-A',
    });
  });

  it('starts with the default name when the recorded folder name cannot name a folder', async () => {
    const folder = await temp();
    const file = path.join(folder, 'export.zip');
    await writeFile(file, await packageOf([], { source: { vaultId: '00000000-0000-4000-8000-000000000000', machine: 'A', folderName: 'a:b' } }));
    expect(await describePackage(file, PRODUCT_SOURCES)).toMatchObject({ folderName: 'XR Collector', exportedAt: null, documents: 0, subscriptions: 0 });
  });

  it('refuses a file that is no export', async () => {
    const folder = await temp();
    const file = path.join(folder, 'other.zip');
    await writeFile(file, 'not a zip');
    await expect(describePackage(file, PRODUCT_SOURCES)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(describePackage(path.join(folder, 'missing.zip'), PRODUCT_SOURCES)).rejects.toMatchObject({ message: '找不到這個匯出檔。' });
  });
});

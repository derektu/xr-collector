// Broken, old search databases fill the disk, or another Vault's search data is deleted.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareSearchDatabase, searchDatabasePath } from '../../../src/domain/search/search-projection.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('keeps the current version of this Vault and deletes its other versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-search-database-'));
  roots.push(root);
  const profile = path.join(root, 'profile');
  const searchData = path.join(profile, 'search');
  const vaultRoot = path.join(root, 'vault');
  const current = searchDatabasePath(searchData, vaultRoot);
  const otherVersion = current.replace(/-v\d+$/u, '-v0');
  const otherVault = searchDatabasePath(searchData, path.join(root, 'other-vault'));
  for (const directory of [current, otherVersion, otherVault]) await mkdir(directory, { recursive: true });
  for (const file of [`${current}-state.json`, `${current}.pid`, `${otherVersion}-state.json`, `${otherVersion}.pid`,
    `${otherVault}-state.json`, path.join(profile, 'settings.json')]) {
    await writeFile(file, '');
  }

  expect(await prepareSearchDatabase({ searchData, vaultRoot })).toBe(current);

  expect((await readdir(profile)).sort()).toEqual([current, `${current}-state.json`, `${current}.pid`, otherVault, `${otherVault}-state.json`, path.join(profile, 'settings.json')]
    .map((entry) => path.basename(entry)).sort());
});

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEARCH_INDEX_PROFILE } from '../../src/search/meilisearch-runtime.js';
import { prepareOwnedSearchProjection, searchDatabasePath, searchProfilePath } from '../../src/search/search-projection.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-projection-'));
  roots.push(root);
  const searchData = path.join(root, 'profile', 'search');
  const vaultRoot = path.join(root, 'vault');
  const database = searchDatabasePath(searchData, vaultRoot);
  const binary = path.join(root, 'meilisearch');
  await mkdir(database, { recursive: true });
  await writeFile(binary, 'unused');
  await writeFile(path.join(database, 'old'), 'projection');
  await writeFile(`${database}-state.json`, 'state');
  await writeFile(`${database}-adjacent`, 'keep');
  const otherDatabase = searchDatabasePath(searchData, `${vaultRoot}-other`);
  await mkdir(otherDatabase, { recursive: true });
  await writeFile(path.join(otherDatabase, 'other'), 'keep');
  return { root, searchData, vaultRoot, database, binaryPath: binary, otherDatabase };
}

describe('owned search projection profile', () => {
  it('keeps a matching projection and commits no new marker', async () => {
    const context = await setup();
    await writeFile(searchProfilePath(context.database), JSON.stringify({ schemaVersion: 1, profile: SEARCH_INDEX_PROFILE }));
    const prepared = await prepareOwnedSearchProjection(context);
    expect(prepared.forceRebuild).toBe(false);
    expect(await readFile(path.join(context.database, 'old'), 'utf8')).toBe('projection');
  });

  it.each(['{broken', 'null'])('clears only the derived database sidecars for corrupt marker %j and writes the marker on explicit success', async (marker) => {
    const context = await setup();
    await writeFile(searchProfilePath(context.database), marker);
    const prepared = await prepareOwnedSearchProjection(context);
    expect(prepared.forceRebuild).toBe(true);
    await expect(readFile(path.join(context.database, 'old'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${context.database}-state.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(`${context.database}-adjacent`, 'utf8')).toBe('keep');
    expect(await readFile(path.join(context.otherDatabase, 'other'), 'utf8')).toBe('keep');
    await expect(readFile(searchProfilePath(context.database))).rejects.toMatchObject({ code: 'ENOENT' });
    await prepared.recordRebuild();
    expect(JSON.parse(await readFile(searchProfilePath(context.database), 'utf8'))).toEqual({ schemaVersion: 1, profile: SEARCH_INDEX_PROFILE });
  });

  it('refuses to clear a symlink at any managed deletion target', async () => {
    const context = await setup();
    const outside = path.join(context.root, 'outside');
    await mkdir(outside);
    await rm(context.database, { recursive: true });
    await symlink(outside, context.database, 'dir');
    await expect(prepareOwnedSearchProjection(context)).rejects.toThrow(/symlinked/u);
    expect(await readFile(`${context.database}-adjacent`, 'utf8')).toBe('keep');
  });

  it('does not clear the database when the leftover process record cannot be verified', async () => {
    const context = await setup();
    await writeFile(`${context.database}.pid`, '{broken');
    await expect(prepareOwnedSearchProjection(context)).rejects.toThrow(/Cannot verify/u);
    expect(await readFile(path.join(context.database, 'old'), 'utf8')).toBe('projection');
    expect(await readFile(`${context.database}.pid`, 'utf8')).toBe('{broken');
  });
});

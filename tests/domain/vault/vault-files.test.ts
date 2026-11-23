import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each([
  ['writeJson', (files: VaultFileWriter, file: string) => files.writeJson(file, {})],
  ['writeText', (files: VaultFileWriter, file: string) => files.writeText(file, 'x')],
  ['create', (files: VaultFileWriter, file: string) => files.create(file, 'x')],
  ['remove', (files: VaultFileWriter, file: string) => files.remove(file)],
] as const)('refuses %s for a path the Vault does not register and writes nothing, so an export carries every file the Vault keeps', async (_name, write) => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-vault-files-'));
  roots.push(root);
  const files = new VaultFileWriter(root, PRODUCT_SOURCES);
  for (const file of ['settings/tags.json', 'notes/x.md', 'documents/youtube/notes.txt']) {
    await expect(write(files, file), file).rejects.toThrow(`Not a Vault file: ${file}`);
  }
  expect(await readdir(root)).toEqual([]);
  expect(existsSync(path.join(root, 'settings'))).toBe(false);
});

it('writes a registered path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-vault-files-'));
  roots.push(root);
  await new VaultFileWriter(root, PRODUCT_SOURCES).writeJson('settings/youtube-schedule.json', { version: 2, enabled: true });
  expect(existsSync(path.join(root, 'settings', 'youtube-schedule.json'))).toBe(true);
});

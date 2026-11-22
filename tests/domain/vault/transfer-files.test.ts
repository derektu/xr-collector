import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { isWithin } from '../../../src/domain/vault/transfer-files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function caseInsensitive(root: string): Promise<boolean> {
  await mkdir(path.join(root, 'Probe'));
  return stat(path.join(root, 'probe')).then(() => true, () => false);
}

it('treats another spelling of a folder as the same folder on a case-insensitive volume, since realpath returns the spelling on disk', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-within-'));
  roots.push(root);
  if (!await caseInsensitive(root)) context.skip();
  await mkdir(path.join(root, 'Vault'));

  expect(await isWithin(path.join(root, 'vault', 'export.zip'), path.join(root, 'Vault'))).toBe(true);
  expect(await isWithin(path.join(root, 'VAULT'), path.join(root, 'vault'))).toBe(true);
  expect(await isWithin(path.join(root, 'Other'), path.join(root, 'Vault'))).toBe(false);
});

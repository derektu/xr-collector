import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceVaults } from '../../../src/domain/vault/index.js';
import { createVaultDirectory } from '../../../src/domain/vault/vault-directory.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function device(profile = 'profile') {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-device-vaults-'));
  roots.push(root);
  const location = path.join(root, 'location');
  await mkdir(location);
  const profilePath = path.join(root, profile);
  return { root, location, profilePath, vaults: new DeviceVaults({ profilePath, sources: PRODUCT_SOURCES, createdBy: 'test' }) };
}

function failingStart(): Promise<never> {
  return Promise.reject(new Error('search did not start'));
}

describe('DeviceVaults.setUp', () => {
  it('removes a Vault it created when its services cannot start, so the location stays as it was and no selection names it', async () => {
    const { location, vaults } = await device();

    await expect(vaults.setUp({ action: 'create', location, name: 'XR' }, failingStart)).rejects.toMatchObject({ code: 'vault_invalid' });

    expect(await readdir(location)).toEqual([]);
    expect(await vaults.selection.read()).toBeNull();
  });

  it('keeps a Vault it opened when its services cannot start, since the folder was there before', async () => {
    const { location, vaults } = await device();
    const existing = await createVaultDirectory(path.join(location, 'Existing'), 'test', PRODUCT_SOURCES);

    await expect(vaults.setUp({ action: 'open', path: existing }, failingStart)).rejects.toMatchObject({ code: 'vault_invalid' });

    expect(await readdir(location)).toEqual(['Existing']);
    expect(await vaults.selection.read()).toBeNull();
  });

  it('closes the started services and removes the created Vault when the selection cannot be written, so a restart never opens a Vault nothing names', async () => {
    const { root, location, profilePath, vaults } = await device('profile-file');
    await writeFile(profilePath, '');
    let closed = false;

    await expect(vaults.setUp({ action: 'create', location, name: 'XR' }, async () => ({ close: async () => { closed = true; } })))
      .rejects.toMatchObject({ code: 'vault_invalid' });

    expect(closed).toBe(true);
    expect(await readdir(location)).toEqual([]);
    expect(await readdir(root)).toEqual(['location', 'profile-file']);
  });
});

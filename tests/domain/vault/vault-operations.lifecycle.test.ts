import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptSearch } from '../../../src/shared/api/search-types.js';
import { openVault, type OpenedVault } from '../../../src/domain/vault/opened-vault.js';
import { createVaultDirectory } from '../../../src/domain/vault/vault-directory.js';
import { VaultOperations } from '../../../src/domain/vault/vault-operations.js';
import { VaultSelection } from '../../../src/domain/vault/vault-selection.js';
import { cleanUp, fakeSearch, seed, temp } from '../../support/exchange-fixtures.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

afterEach(cleanUp);

interface Lifecycle {
  root: string;
  operations: VaultOperations;
  steps: string[];
}

async function lifecycle(): Promise<Lifecycle> {
  const root = await temp('xr-lifecycle-');
  const vault = path.join(root, 'Vault');
  await createVaultDirectory(vault, 'XR Collector test', PRODUCT_SOURCES);
  await seed(vault);
  const selection = new VaultSelection(path.join(root, 'profile', 'vault-selection.json'));
  const selected = () => existsSync(selection.file) ? (JSON.parse(readFileSync(selection.file, 'utf8')) as { path: string }).path : null;
  const steps: string[] = [];
  let current: { vault: OpenedVault; search: TranscriptSearch } = { vault: await openVault(vault, PRODUCT_SOURCES), search: fakeSearch(vault) };
  const operations = new VaultOperations({
    sources: PRODUCT_SOURCES, selection, exportFolder: path.join(root, 'exports'),
    backupFolder: path.join(root, 'backups'), createdBy: 'XR Collector test', machineName: '測試機', noteChange: () => undefined,
  }, {
    current: () => current,
    hold: async () => () => undefined,
    idle: async () => undefined,
    suspend: () => undefined,
    event: () => undefined,
    flushJobs: async () => undefined,
    reloadSchedule: async () => undefined,
    prepare: async (candidateRoot) => {
      const candidate = { vault: await openVault(candidateRoot, PRODUCT_SOURCES), search: fakeSearch(candidateRoot) };
      steps.push(`prepare, selection ${selected()}`);
      return {
        activate: () => {
          steps.push(`activate, selection ${selected()}`);
          const previous = current;
          current = candidate;
          return { root: previous.vault.root, settle: async () => ({ interruptedJobs: 0, resumedJobs: 0 }) };
        },
        discard: async () => undefined,
      };
    },
  });
  return {
    root, operations, steps,
  };
}

describe('opening another Vault', () => {
  it('names the other Vault in the device selection before making it the one in use, so a restart opens the Vault in use', async () => {
    const context = await lifecycle();
    const other = path.join(context.root, 'Other');
    await createVaultDirectory(other, 'XR Collector test', PRODUCT_SOURCES);
    await context.operations.openOther(other);
    await context.operations.finished();
    expect(context.operations.status()).toMatchObject({ state: 'completed', operation: 'open', vaultPath: other });
    expect(context.steps).toEqual([`prepare, selection null`, `activate, selection ${other}`]);
  });
});

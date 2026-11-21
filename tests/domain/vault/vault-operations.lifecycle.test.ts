import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewJobEvent } from '../../../src/shared/activity/activity-types.js';
import type { TranscriptSearch } from '../../../src/shared/api/search-types.js';
import { MarkdownVault } from '../../../src/domain/vault/markdown-vault.js';
import { openVault, type OpenedVault } from '../../../src/domain/vault/opened-vault.js';
import { createVaultDirectory, VAULT_MARKER } from '../../../src/domain/vault/vault-directory.js';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import { VaultOperations } from '../../../src/domain/vault/vault-operations.js';
import { VaultSelection } from '../../../src/domain/vault/vault-selection.js';
import { transcriptDocument } from '../../../src/domain/sources/youtube/server.js';
import { cleanUp, fakeSearch, seed, temp, video } from '../../support/exchange-fixtures.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { eventually } from '../../support/wait.js';

afterEach(cleanUp);

interface Lifecycle {
  root: string;
  vault: string;
  selection: VaultSelection;
  operations: VaultOperations;
  steps: string[];
  current(): string;
  releaseHold(): void;
  holdNext(): void;
}

async function lifecycle(failingEvent?: NewJobEvent['eventType']): Promise<Lifecycle> {
  const root = await temp('xr-lifecycle-');
  const vault = path.join(root, 'Vault');
  await createVaultDirectory(vault, 'XR Collector test', PRODUCT_SOURCES);
  await seed(vault);
  const selection = new VaultSelection(path.join(root, 'profile', 'vault-selection.json'));
  const selected = () => existsSync(selection.file) ? (JSON.parse(readFileSync(selection.file, 'utf8')) as { path: string }).path : null;
  const steps: string[] = [];
  let current: { vault: OpenedVault; search: TranscriptSearch } = { vault: await openVault(vault, PRODUCT_SOURCES), search: fakeSearch(vault) };
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => undefined;
  const operations = new VaultOperations({
    sources: PRODUCT_SOURCES, selection, profilePath: path.join(root, 'profile'), exportFolder: path.join(root, 'exports'),
    backupFolder: path.join(root, 'backups'), createdBy: 'XR Collector test', machineName: '測試機', noteChange: () => undefined,
  }, {
    current: () => current,
    hold: async () => { await gate; return () => undefined; },
    idle: async () => undefined,
    suspend: () => undefined,
    event: (entry) => { if (entry.eventType === failingEvent) throw new Error(`${entry.eventType} not recorded`); },
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
    root, vault, selection, operations, steps,
    current: () => current.vault.root,
    releaseHold: () => open(),
    holdNext: () => { gate = new Promise((resolve) => { open = resolve; }); },
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

describe('creating a new Vault', () => {
  it('keeps the new Vault once it is the one in use, even when a later step fails, because the selection already names it', async () => {
    const context = await lifecycle('vault.created');
    await context.operations.createNew(context.root, 'Second');
    await context.operations.finished();
    const created = path.join(context.root, 'Second');
    expect(context.operations.status()).toMatchObject({ state: 'error', operation: 'create', vaultPath: created });
    expect(context.current()).toBe(created);
    expect(await context.selection.read()).toBe(created);
    expect(existsSync(path.join(created, VAULT_MARKER))).toBe(true);
  });
});

describe('an import comparison', () => {
  it('stays usable when another comparison is refused because the Vault is busy, since the refusal changes nothing', async () => {
    const context = await lifecycle();
    const file = path.join(context.root, 'exports', 'before.zip');
    await mkdir(path.dirname(file), { recursive: true });
    await context.operations.exportTo(file);
    await new MarkdownVault(new VaultFileWriter(context.vault, PRODUCT_SOURCES)).add(transcriptDocument(video('lifecycle01')));
    const preview = await context.operations.previewImport(file);

    context.holdNext();
    const exporting = context.operations.exportTo(path.join(context.root, 'exports', 'during.zip'));
    await eventually(() => expect(context.operations.status()).toMatchObject({ state: 'waiting', operation: 'export' }));
    await expect(context.operations.previewImport(file)).rejects.toMatchObject({ code: 'vault_busy' });
    context.releaseHold();
    await exporting;

    context.operations.applyImport(preview.id, 'replace');
    await context.operations.finished();
    expect(context.operations.status()).toMatchObject({ state: 'completed', operation: 'import', result: { importMode: 'replace' } });
  });
});

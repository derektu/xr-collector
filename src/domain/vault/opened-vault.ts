import type { TranscriptSearch } from '../../shared/api/search-types.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import { Collector, type CollectorOptions } from './collector.js';
import { MarkdownVault } from './markdown-vault.js';
import { readVaultId } from './vault-directory.js';
import { VaultFileWriter } from './vault-files.js';
import { removeImportStaging } from './vault-import.js';

/** A Vault's files, opened for the services built on them. */
export interface OpenedVault {
  readonly root: string;
  readonly vaultId: string;
  /** The way every write of the Vault's files goes, also that of the subscription and schedule stores. */
  readonly files: VaultFileWriter;
  /** The Vault's documents and deletion records, as search reads them. */
  readonly documents: MarkdownVault;
  /** The collector that saves documents to this Vault and keeps `search` in step with them. */
  collector(search: TranscriptSearch, options: CollectorOptions): Collector;
}

/**
 * Opens the Vault at `root`, which holds the types of `sources`: reads its ID from the marker and
 * removes the staging folders of imports a stop interrupted.
 */
export async function openVault(root: string, sources: SourceRegistry): Promise<OpenedVault> {
  const vaultId = await readVaultId(root);
  if (!vaultId) throw new CollectorError('vault_invalid', '知識庫標記檔沒有識別碼，不是目前支援的知識庫格式，無法開啟。');
  await removeImportStaging(root);
  const files = new VaultFileWriter(root, sources);
  const documents = new MarkdownVault(files);
  return {
    root, vaultId, files, documents,
    collector: (search, options) => new Collector(documents, search, options),
  };
}

import type { TranscriptSearch } from '../../shared/api/search-types.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import { Collector, type CollectorOptions } from './collector.js';
import { MarkdownVault } from './markdown-vault.js';
import { readVaultId } from './vault-directory.js';
import { VaultFileWriter } from './vault-files.js';
import { removeImportStaging } from './vault-import.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export interface OpenedVault {
  readonly root: string;
  readonly vaultId: string;
  readonly files: VaultFileWriter;
  readonly documents: MarkdownVault;
  collector(search: TranscriptSearch, options: Omit<CollectorOptions, 'log'>): Collector;
}

export async function openVault(root: string, sources: SourceRegistry, log: LogWriter): Promise<OpenedVault> {
  const vaultId = await readVaultId(root);
  if (!vaultId) throw new CollectorError('vault_invalid', '知識庫標記檔沒有識別碼，不是目前支援的知識庫格式，無法開啟。');
  await removeImportStaging(root, log);
  const files = new VaultFileWriter(root, sources);
  const documents = new MarkdownVault(files);
  return {
    root, vaultId, files, documents,
    collector: (search, options) => new Collector(documents, search, { ...options, log }),
  };
}

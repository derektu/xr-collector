import type { NewJobEvent } from '../../shared/activity/activity-types.js';
import type { TranscriptSearch } from '../../shared/api/search-types.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import { Collector, type CollectorOptions } from './collector.js';
import { deletionId } from './deleted-documents.js';
import { MarkdownVault } from './markdown-vault.js';
import { readVaultId } from './vault-directory.js';
import { VaultFileWriter } from './vault-files.js';

/** An event about a Vault's documents, recorded in the activity log under that Vault. */
export type VaultEvent = Omit<NewJobEvent, 'vaultPath' | 'jobId'>;

/** A Vault's files, opened for the services built on them. */
export interface OpenedVault {
  readonly root: string;
  /** ID from the Vault's marker. */
  readonly vaultId: string;
  /** The way every write of the Vault's files goes, also that of the subscription and schedule stores. */
  readonly files: VaultFileWriter;
  /** The Vault's documents and deletion records, as search reads them. */
  readonly documents: MarkdownVault;
  /** What opening settled of deletions a stop left unfinished, as activity events in the order they happened. */
  readonly recoveryEvents: readonly VaultEvent[];
  /** The collector that saves documents to this Vault and keeps `search` in step with them. */
  collector(search: TranscriptSearch, options: CollectorOptions): Collector;
}

/**
 * Opens the Vault at `root`, which holds the types of `sources`: reads its ID from the marker and
 * settles deletions a stop left unfinished, before any search index is compared with the Vault.
 */
export async function openVault(root: string, sources: SourceRegistry): Promise<OpenedVault> {
  const vaultId = await readVaultId(root);
  if (!vaultId) throw new CollectorError('vault_invalid', '知識庫標記檔沒有識別碼，不是目前支援的知識庫格式，無法開啟。');
  const files = new VaultFileWriter(root, sources);
  const documents = new MarkdownVault(files);
  const recovery = await documents.recoverDeletions();
  const recoveryEvents: VaultEvent[] = [
    ...recovery.completed.map((record): VaultEvent => ({
      eventType: 'document.delete_resumed', message: `已完成上次未完成的刪除：「${record.title}」。`,
      documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title, namesSource: true,
    })),
    ...recovery.unresolved.map((record): VaultEvent => ({
      eventType: 'document.delete_unresolved',
      message: `「${record.title}」有刪除紀錄，但文件檔缺少可讀的收集時間；文件維持隱藏，檔案與刪除紀錄都保留。`,
      documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title, namesSource: true,
    })),
    ...recovery.cleared.map((record): VaultEvent => ({
      eventType: 'document.recollected', message: `已重新收集「${record.title}」，解除刪除紀錄。`,
      documentId: deletionId(record), sourceId: record.sourceId, sourceTitle: record.title, namesSource: true,
    })),
  ];
  return {
    root, vaultId, files, documents, recoveryEvents,
    collector: (search, options) => new Collector(documents, search, options),
  };
}

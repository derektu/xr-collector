import type { DocumentVault } from '../core/collector.js';
import type { SavedDocument, TranscriptSearch } from '../core/types.js';
import {
  ManagedTranscriptSearch,
  UnavailableTranscriptSearch,
} from './managed-transcript-search.js';
import { MeilisearchBackend } from './meilisearch-backend.js';
import { startMeilisearchProcess } from './meilisearch-process.js';

interface StartSearchRuntimeOptions {
  vault: DocumentVault;
  binaryPath: string;
  databasePath: string;
  port?: number;
}

export interface SearchRuntime {
  search: TranscriptSearch;
  close(): Promise<void>;
}

export async function startSearchRuntime(
  options: StartSearchRuntimeOptions,
): Promise<SearchRuntime> {
  try {
    const process = await startMeilisearchProcess({
      binaryPath: options.binaryPath,
      databasePath: options.databasePath,
      ...(options.port ? { port: options.port } : {}),
    });
    const search = new ManagedTranscriptSearch(
      new MeilisearchBackend({
        baseUrl: process.url,
        apiKey: process.apiKey,
      }),
      () => loadAllDocuments(options.vault),
    );
    void search.start().catch(() => undefined);
    return {
      search,
      close: () => process.close(),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      search: new UnavailableTranscriptSearch(`無法啟動搜尋引擎：${detail}`),
      close: async () => undefined,
    };
  }
}

async function loadAllDocuments(vault: DocumentVault): Promise<SavedDocument[]> {
  const summaries = await vault.list();
  const documents = await Promise.all(summaries.map(({ id }) => vault.read(id)));
  return documents.filter((document): document is SavedDocument => document !== null);
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentVault } from '../core/collector.js';
import type { SavedDocument, TranscriptSearch } from '../core/types.js';
import {
  ManagedTranscriptSearch,
  UnavailableTranscriptSearch,
  type SearchStateStore,
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
      fileSearchStateStore(`${options.databasePath}-state.json`),
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

/** Keeps search maintenance state beside the search database, outside the Vault. */
export function fileSearchStateStore(filePath: string): SearchStateStore {
  return {
    async load() {
      try {
        const value = JSON.parse(await readFile(filePath, 'utf8')) as { lastRebuiltAt?: unknown };
        return { lastRebuiltAt: typeof value.lastRebuiltAt === 'string' ? value.lastRebuiltAt : null };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lastRebuiltAt: null };
        throw error;
      }
    },
    async save(state) {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), 'utf8');
      await rename(temporary, filePath);
    },
  };
}

async function loadAllDocuments(vault: DocumentVault): Promise<SavedDocument[]> {
  const metadata = await vault.list();
  const documents = await Promise.all(metadata.map(({ id }) => vault.read(id)));
  return documents.filter((document): document is SavedDocument => document !== null);
}

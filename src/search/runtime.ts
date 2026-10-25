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
import { validateMeilisearchRuntime, type SearchIndexProfile } from './meilisearch-runtime.js';
import type { PreparedSearchProjection } from './search-projection.js';

interface StartSearchRuntimeOptions {
  vault: DocumentVault;
  binaryPath: string;
  databasePath: string;
  port?: number;
  prepareProjection(profile: SearchIndexProfile): Promise<PreparedSearchProjection>;
}

export interface SearchRuntime {
  search: TranscriptSearch;
  close(): Promise<void>;
}

export async function startSearchRuntime(
  options: StartSearchRuntimeOptions,
): Promise<SearchRuntime> {
  try {
    const runtime = await validateMeilisearchRuntime(options.binaryPath);
    const projection = await options.prepareProjection(runtime.searchProfile);
    if (path.resolve(projection.databasePath) !== path.resolve(options.databasePath)) {
      throw new Error('Prepared search projection does not match the owned database path.');
    }
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
      () => new Date(),
      { forceRebuild: projection.forceRebuild, afterRebuild: projection.recordRebuild },
    );
    const initialization = search.start();
    // The search object records the failure state; attach a handler now so a later close can await
    // the same operation without an unhandled rejection in the meantime.
    void initialization.catch(() => undefined);
    return {
      search,
      async close() {
        await initialization.catch(() => undefined);
        await process.close();
      },
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

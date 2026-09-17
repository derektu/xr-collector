import type {
  SavedDocument,
  SearchHit,
  SearchQuery,
  SearchResponse,
} from '../core/types.js';
import type { SearchBackend } from './managed-transcript-search.js';

const INDEX_UID = 'transcripts';

interface MeilisearchBackendOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

interface TaskReference {
  taskUid: number;
}

interface TaskResult {
  uid: number;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  error: { message?: string } | null;
}

interface IndexedDocument {
  key: string;
  id: string;
  title: string;
  channelTitle: string;
  publishedAt: string | null;
  publishedAtEpoch: number | null;
  collectedAt: string;
  languageCode: string;
  subtitleKind: SavedDocument['subtitleKind'];
  bodyMarkdown: string;
}

interface SearchHitDocument extends IndexedDocument {
  _formatted?: {
    bodyMarkdown?: string;
  };
}

interface MeilisearchSearchResponse {
  hits: SearchHitDocument[];
  estimatedTotalHits?: number;
  totalHits?: number;
}

export class MeilisearchBackend implements SearchBackend {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: MeilisearchBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, '');
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async initialize(): Promise<void> {
    const indexResponse = await this.fetchImplementation(
      `${this.baseUrl}/indexes/${INDEX_UID}`,
      { headers: this.headers() },
    );
    if (indexResponse.status === 404) {
      const task = await this.request<TaskReference>('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: INDEX_UID, primaryKey: 'key' }),
      });
      await this.waitForTask(task.taskUid);
    } else if (!indexResponse.ok) {
      throw await this.responseError(indexResponse);
    }

    const settingsTask = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/settings`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          searchableAttributes: ['title', 'channelTitle', 'bodyMarkdown'],
          displayedAttributes: [
            'id',
            'title',
            'channelTitle',
            'publishedAt',
            'collectedAt',
            'languageCode',
            'subtitleKind',
            'bodyMarkdown',
          ],
          filterableAttributes: ['channelTitle', 'publishedAtEpoch'],
        }),
      },
    );
    await this.waitForTask(settingsTask.taskUid);
  }

  async count(): Promise<number> {
    const stats = await this.request<{ numberOfDocuments: number }>(
      `/indexes/${INDEX_UID}/stats`,
    );
    return stats.numberOfDocuments;
  }

  async replaceAll(documents: SavedDocument[]): Promise<void> {
    const deleteTask = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/documents`,
      { method: 'DELETE' },
    );
    await this.waitForTask(deleteTask.taskUid);
    if (documents.length === 0) return;

    const addTask = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/documents`,
      {
        method: 'PUT',
        body: JSON.stringify(documents.map(toIndexedDocument)),
      },
    );
    await this.waitForTask(addTask.taskUid);
  }

  async upsert(document: SavedDocument): Promise<void> {
    const task = await this.request<TaskReference>(
      `/indexes/${INDEX_UID}/documents`,
      {
        method: 'PUT',
        body: JSON.stringify([toIndexedDocument(document)]),
      },
    );
    await this.waitForTask(task.taskUid);
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const filter: string[] = [];
    if (query.channel) {
      filter.push(`channelTitle = ${JSON.stringify(query.channel)}`);
    }
    if (query.publishedFrom) {
      filter.push(`publishedAtEpoch >= ${dateBoundary(query.publishedFrom, 'start')}`);
    }
    if (query.publishedTo) {
      filter.push(`publishedAtEpoch <= ${dateBoundary(query.publishedTo, 'end')}`);
    }

    const result = await this.request<MeilisearchSearchResponse>(
      `/indexes/${INDEX_UID}/search`,
      {
        method: 'POST',
        body: JSON.stringify({
          q: query.query,
          limit: 50,
          attributesToRetrieve: [
            'id',
            'title',
            'channelTitle',
            'publishedAt',
            'collectedAt',
            'languageCode',
            'subtitleKind',
            'bodyMarkdown',
          ],
          attributesToCrop: ['bodyMarkdown:32'],
          cropMarker: '…',
          matchingStrategy: 'all',
          ...(filter.length > 0 ? { filter } : {}),
        }),
      },
    );

    return {
      hits: result.hits.map(toSearchHit),
      estimatedTotalHits: result.estimatedTotalHits ?? result.totalHits ?? result.hits.length,
    };
  }

  private async waitForTask(taskUid: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const task = await this.request<TaskResult>(`/tasks/${taskUid}`);
      if (task.status === 'succeeded') return;
      if (task.status === 'failed' || task.status === 'canceled') {
        throw new Error(task.error?.message ?? `Meilisearch task ${taskUid} ${task.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Meilisearch task ${taskUid} timed out`);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init?.headers),
    });
    if (!response.ok) throw await this.responseError(response);
    return response.json() as Promise<T>;
  }

  private headers(existing?: HeadersInit): Headers {
    const headers = new Headers(existing);
    headers.set('Authorization', `Bearer ${this.options.apiKey}`);
    headers.set('Content-Type', 'application/json');
    return headers;
  }

  private async responseError(response: Response): Promise<Error> {
    const body = await response.json().catch(() => ({})) as { message?: string };
    return new Error(body.message ?? `Meilisearch request failed with HTTP ${response.status}`);
  }
}

function toIndexedDocument(document: SavedDocument): IndexedDocument {
  return {
    key: document.sourceId,
    id: document.id,
    title: document.title,
    channelTitle: document.channelTitle,
    publishedAt: document.publishedAt,
    publishedAtEpoch: document.publishedAt ? Date.parse(document.publishedAt) : null,
    collectedAt: document.collectedAt,
    languageCode: document.languageCode,
    subtitleKind: document.subtitleKind,
    bodyMarkdown: document.bodyMarkdown,
  };
}

function toSearchHit(hit: SearchHitDocument): SearchHit {
  return {
    id: hit.id,
    title: hit.title,
    channelTitle: hit.channelTitle,
    publishedAt: hit.publishedAt,
    collectedAt: hit.collectedAt,
    languageCode: hit.languageCode,
    subtitleKind: hit.subtitleKind,
    snippet: hit._formatted?.bodyMarkdown ?? hit.bodyMarkdown,
  };
}

function dateBoundary(value: string, boundary: 'start' | 'end'): number {
  return Date.parse(`${value}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
}

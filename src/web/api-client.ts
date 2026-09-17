import type {
  CollectResult,
  DocumentSummary,
  SavedDocument,
} from '../core/types.js';

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse;
    throw new ApiError(
      body.error?.message ?? `HTTP ${response.status}`,
      body.error?.code ?? 'unknown_error',
    );
  }
  return response.json() as Promise<T>;
}

export const api = {
  async listDocuments(): Promise<DocumentSummary[]> {
    const result = await request<{ documents: DocumentSummary[] }>('/api/documents');
    return result.documents;
  },

  async readDocument(id: string): Promise<SavedDocument> {
    const result = await request<{ document: SavedDocument }>(
      `/api/documents/${encodeURIComponent(id)}`,
    );
    return result.document;
  },

  collectYouTube(url: string): Promise<CollectResult> {
    return request<CollectResult>('/api/youtube/collect', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },
};

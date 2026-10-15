import type {
  CollectionJob,
  DocumentFilter,
  DocumentPage,
  DocumentSources,
  JobPage,
  JobSubmission,
  SavedDocument,
  SearchQuery,
  SearchResponse,
  SearchStatusReport,
  YouTubeChannel,
  ChannelPreview,
  ChannelSchedule,
  CollectionPolicy,
  Subscription,
  VaultInspection,
  VaultSetupAction,
  VaultSetupResult,
  VaultSetupStatus,
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
  // A JSON content type without a body is rejected by the server, so only label requests that carry one.
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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
  async getVaultSetup(): Promise<VaultSetupStatus> {
    return (await request<{ vault: VaultSetupStatus }>('/api/vault/setup')).vault;
  },

  async inspectVault(path: string): Promise<VaultInspection> {
    return (await request<{ inspection: VaultInspection }>('/api/vault/inspect', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })).inspection;
  },

  setupVault(action: VaultSetupAction, path: string): Promise<VaultSetupResult> {
    return request<VaultSetupResult>('/api/vault/setup', {
      method: 'POST',
      body: JSON.stringify({ action, path }),
    });
  },

  agentConnection(): Promise<{ url: string; connectionFile: string; skillPath: string }> {
    return request('/api/agent/connection');
  },
  async getChannelSchedule(): Promise<ChannelSchedule> {
    const result = await request<{ schedule: ChannelSchedule }>('/api/youtube/schedule');
    return result.schedule;
  },

  /** Saves the given Global settings; fields left out keep their value. */
  async updateChannelSchedule(patch: Partial<CollectionPolicy & { enabled: boolean }>): Promise<ChannelSchedule> {
    const result = await request<{ schedule: ChannelSchedule }>('/api/youtube/schedule', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return result.schedule;
  },

  async listChannels(signal?: AbortSignal): Promise<Subscription[]> {
    const result = await request<{ channels: Subscription[] }>('/api/youtube/channels', signal ? { signal } : undefined);
    return result.channels;
  },

  async previewChannel(url: string): Promise<ChannelPreview> {
    return (await request<{ preview: ChannelPreview }>('/api/youtube/channel-previews', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })).preview;
  },

  addChannel(url: string): Promise<JobSubmission> {
    return request<JobSubmission>('/api/youtube/channels', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  async setChannelEnabled(id: string, enabled: boolean): Promise<{ channel: YouTubeChannel; submission: JobSubmission | null }> {
    return request<{ channel: YouTubeChannel; submission: JobSubmission | null }>(
      `/api/youtube/channels/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      },
    );
  },

  async removeChannel(id: string): Promise<{ documentsKept: number }> {
    return request<{ removed: true; documentsKept: number }>(`/api/youtube/channels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /** Checks every enabled subscription now. */
  async checkAllChannels(): Promise<JobSubmission[]> {
    const result = await request<{ submissions: JobSubmission[] }>('/api/youtube/channel-runs', { method: 'POST' });
    return result.submissions;
  },

  /** Accepts a video or channel address; the service decides which by its syntax. */
  submitYouTube(url: string): Promise<JobSubmission> {
    return request<JobSubmission>('/api/youtube/submissions', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  listJobs(query: { state?: 'active' | 'all'; limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<JobPage> {
    const parameters = new URLSearchParams();
    if (query.state) parameters.set('state', query.state);
    if (query.limit) parameters.set('limit', String(query.limit));
    if (query.cursor) parameters.set('cursor', query.cursor);
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
    return request<JobPage>(`/api/jobs${suffix}`, signal ? { signal } : undefined);
  },

  async getJob(id: string): Promise<CollectionJob> {
    return (await request<{ job: CollectionJob }>(`/api/jobs/${encodeURIComponent(id)}`)).job;
  },

  listDocuments(query: DocumentFilter & { offset: number; limit: number }, signal?: AbortSignal): Promise<DocumentPage> {
    const parameters = filterParameters(query);
    parameters.set('offset', String(query.offset));
    parameters.set('limit', String(query.limit));
    return request<DocumentPage>(`/api/documents?${parameters.toString()}`, signal ? { signal } : undefined);
  },

  async documentSources(signal?: AbortSignal): Promise<DocumentSources> {
    return (await request<{ sources: DocumentSources }>('/api/documents/sources', signal ? { signal } : undefined)).sources;
  },

  async readDocument(id: string, signal?: AbortSignal): Promise<SavedDocument> {
    const result = await request<{ document: SavedDocument }>(
      `/api/documents/${encodeURIComponent(id)}`,
      signal ? { signal } : undefined,
    );
    return result.document;
  },

  collectYouTube(url: string): Promise<JobSubmission> {
    return request<JobSubmission>('/api/youtube/collect', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  searchDocuments(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> {
    const parameters = filterParameters(query);
    parameters.set('q', query.query);
    if (query.publishedFrom) parameters.set('publishedFrom', query.publishedFrom);
    if (query.publishedTo) parameters.set('publishedTo', query.publishedTo);
    if (query.offset !== undefined) parameters.set('offset', String(query.offset));
    if (query.limit !== undefined) parameters.set('limit', String(query.limit));
    return request<SearchResponse>(`/api/search?${parameters.toString()}`, signal ? { signal } : undefined);
  },

  async getSearchStatus(): Promise<SearchStatusReport> {
    const result = await request<{ status: SearchStatusReport }>('/api/search/status');
    return result.status;
  },

  async rebuildSearch(): Promise<SearchStatusReport> {
    const result = await request<{ status: SearchStatusReport }>('/api/search/rebuild', {
      method: 'POST',
    });
    return result.status;
  },
};

function filterParameters(filter: DocumentFilter): URLSearchParams {
  const parameters = new URLSearchParams();
  if (filter.sourceType) parameters.set('sourceType', filter.sourceType);
  if (filter.publisherId) parameters.set('publisherId', filter.publisherId);
  return parameters;
}

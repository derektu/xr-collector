import type {
  CollectionJob,
  DocumentSummary,
  JobPage,
  JobSubmission,
  SavedDocument,
  SearchQuery,
  SearchResponse,
  SearchStatus,
  YouTubeChannel,
  ChannelSchedule,
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

  async updateChannelSchedule(enabled: boolean, intervalMinutes: number): Promise<ChannelSchedule> {
    const result = await request<{ schedule: ChannelSchedule }>('/api/youtube/schedule', {
      method: 'PUT',
      body: JSON.stringify({ enabled, intervalMinutes }),
    });
    return result.schedule;
  },

  async listChannels(): Promise<YouTubeChannel[]> {
    const result = await request<{ channels: YouTubeChannel[] }>('/api/youtube/channels');
    return result.channels;
  },

  addChannel(url: string): Promise<JobSubmission> {
    return request<JobSubmission>('/api/youtube/channels', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  async setChannelEnabled(id: string, enabled: boolean): Promise<YouTubeChannel> {
    const result = await request<{ channel: YouTubeChannel }>(
      `/api/youtube/channels/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      },
    );
    return result.channel;
  },

  async removeChannel(id: string): Promise<void> {
    await request<{ removed: true }>(`/api/youtube/channels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async startChannelRun(channelIds?: string[]): Promise<JobSubmission[]> {
    const result = await request<{ submissions: JobSubmission[] }>('/api/youtube/channel-runs', {
      method: 'POST',
      body: JSON.stringify(channelIds ? { channelIds } : {}),
    });
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

  collectYouTube(url: string): Promise<JobSubmission> {
    return request<JobSubmission>('/api/youtube/collect', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  searchDocuments(query: SearchQuery): Promise<SearchResponse> {
    const parameters = new URLSearchParams({ q: query.query });
    if (query.channel) parameters.set('channel', query.channel);
    if (query.publishedFrom) parameters.set('publishedFrom', query.publishedFrom);
    if (query.publishedTo) parameters.set('publishedTo', query.publishedTo);
    return request<SearchResponse>(`/api/search?${parameters.toString()}`);
  },

  async getSearchStatus(): Promise<SearchStatus> {
    const result = await request<{ status: SearchStatus }>('/api/search/status');
    return result.status;
  },

  async rebuildSearch(): Promise<SearchStatus> {
    const result = await request<{ status: SearchStatus }>('/api/search/rebuild', {
      method: 'POST',
    });
    return result.status;
  },
};

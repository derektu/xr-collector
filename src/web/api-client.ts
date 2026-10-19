import type {
  ActivityPage,
  ActivityQuery,
  CollectionJob,
  JobSummary,
  DocumentFilter,
  DocumentDeletion,
  DocumentPage,
  DocumentSources,
  JobPage,
  JobSubmission,
  MoveCheck,
  TransferStatus,
  SavedDocument,
  SearchQuery,
  SearchResponse,
  SearchStatusReport,
  YouTubeChannel,
  ChannelPreview,
  ChannelSchedule,
  CollectionPolicy,
  RecognitionAction,
  SourceDetail,
  SourceList,
  SourceTypeInfo,
  Subscription,
  UrlRecognition,
  VaultInspection,
  VaultSetupAction,
  ExportSuggestion,
  ImportChoice,
  ImportMode,
  ImportPreview,
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

  setupVault(action: VaultSetupAction, path: string, packagePath?: string): Promise<VaultSetupResult> {
    return request<VaultSetupResult>('/api/vault/setup', {
      method: 'POST',
      body: JSON.stringify({ action, path, ...(packagePath ? { packagePath } : {}) }),
    });
  },

  agentConnection(): Promise<{ url: string; connectionFile: string; skillPath: string }> {
    return request('/api/agent/connection');
  },
  async getChannelSchedule(): Promise<ChannelSchedule> {
    const result = await request<{ schedule: ChannelSchedule }>('/api/youtube/schedule');
    return result.schedule;
  },

  /** Turns automatic collection on or off. */
  async setAutoCollection(enabled: boolean): Promise<ChannelSchedule> {
    const result = await request<{ schedule: ChannelSchedule }>('/api/youtube/schedule', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    return result.schedule;
  },

  /** Saves some of one subscription's settings; fields left out keep their value. */
  async updateChannelSettings(id: string, settings: Partial<CollectionPolicy>): Promise<YouTubeChannel> {
    const result = await request<{ channel: YouTubeChannel }>(`/api/youtube/channels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ settings }),
    });
    return result.channel;
  },

  /** Gives every other subscription of the same type this subscription's settings. */
  applyChannelSettings(id: string): Promise<{ updated: number; paused: number }> {
    return request<{ updated: number; paused: number }>(`/api/youtube/channels/${encodeURIComponent(id)}/apply-settings`, { method: 'POST' });
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

  addChannel(url: string, settings?: Partial<CollectionPolicy>): Promise<JobSubmission> {
    return request<JobSubmission>('/api/youtube/channels', {
      method: 'POST',
      body: JSON.stringify(settings ? { url, settings } : { url }),
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

  async jobSummary(since: string, signal?: AbortSignal): Promise<JobSummary> {
    return (await request<{ summary: JobSummary }>(`/api/jobs/summary?${new URLSearchParams({ since }).toString()}`, signal ? { signal } : undefined)).summary;
  },

  retryJob(id: string): Promise<JobSubmission> {
    return request<JobSubmission>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },

  activity(query: ActivityQuery, signal?: AbortSignal): Promise<ActivityPage> {
    const parameters = new URLSearchParams();
    if (query.severity) parameters.set('severity', query.severity.join(','));
    if (query.eventType) parameters.set('eventType', query.eventType.join(','));
    for (const key of ['jobId', 'subscriptionId', 'since', 'until', 'cursor'] as const) {
      const value = query[key];
      if (value) parameters.set(key, value);
    }
    if (query.limit) parameters.set('limit', String(query.limit));
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
    return request<ActivityPage>(`/api/activity${suffix}`, signal ? { signal } : undefined);
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

  /** Deletes a document; automatic and channel collection skip it until the user collects it again by its address. */
  deleteDocument(id: string): Promise<DocumentDeletion> {
    return request<DocumentDeletion>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

  async sourceTypes(): Promise<SourceTypeInfo[]> {
    return (await request<{ sourceTypes: SourceTypeInfo[] }>('/api/source-types')).sourceTypes;
  },

  async recognizeUrl(url: string, signal?: AbortSignal): Promise<UrlRecognition> {
    return (await request<{ recognition: UrlRecognition }>('/api/url-recognitions', {
      method: 'POST',
      body: JSON.stringify({ url }),
      ...(signal ? { signal } : {}),
    })).recognition;
  },

  /** Sends the request a recognized address offers, exactly as the service described it. */
  performAction(action: RecognitionAction): Promise<unknown> {
    return request(action.request.path, { method: action.request.method, body: JSON.stringify(action.request.body) });
  },

  listSources(signal?: AbortSignal): Promise<SourceList> {
    return request<SourceList>('/api/sources', signal ? { signal } : undefined);
  },

  sourceDetail(type: string, id: string, signal?: AbortSignal): Promise<SourceDetail> {
    return request<SourceDetail>(`/api/sources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, signal ? { signal } : undefined);
  },

  /** Checks the listed subscriptions now. */
  async checkChannels(channelIds: string[]): Promise<JobSubmission[]> {
    const result = await request<{ submissions: JobSubmission[] }>('/api/youtube/channel-runs', {
      method: 'POST',
      body: JSON.stringify({ channelIds }),
    });
    return result.submissions;
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

  vaultTransferStatus(): Promise<TransferStatus> {
    return request<TransferStatus>('/api/vault/status');
  },

  /** The export folder and today's export file in it. */
  exportSuggestion(): Promise<ExportSuggestion> {
    return request<ExportSuggestion>('/api/vault/export/suggestion');
  },

  /** Writes the export of the active Vault to an absolute `.zip` path on this computer. */
  exportVault(path: string, overwrite: boolean): Promise<TransferStatus> {
    return request<TransferStatus>('/api/vault/export', { method: 'POST', body: JSON.stringify({ path, overwrite }) });
  },

  /** Compares an export file with the active Vault. */
  previewImport(path: string): Promise<ImportPreview> {
    return request<ImportPreview>('/api/vault/import/preview', { method: 'POST', body: JSON.stringify({ path }) });
  },

  /** Applies a compared import; follow `vaultTransferStatus`. */
  applyImport(id: string, mode: ImportMode, choices: Record<string, ImportChoice>): Promise<TransferStatus> {
    return request<TransferStatus>('/api/vault/import/apply', { method: 'POST', body: JSON.stringify({ id, mode, choices }) });
  },

  async cancelImport(id: string): Promise<void> {
    await request('/api/vault/import/cancel', { method: 'POST', body: JSON.stringify({ id }) });
  },

  /** Checks a new location for the active Vault without moving it; refusals arrive as `ApiError`. */
  checkVaultMove(targetPath: string, signal?: AbortSignal): Promise<MoveCheck> {
    return request<MoveCheck>('/api/vault/move/check', { method: 'POST', body: JSON.stringify({ targetPath }), signal });
  },

  /** Moves the active Vault to `targetPath` and continues its work there; follow `vaultTransferStatus`. */
  moveVault(targetPath: string): Promise<TransferStatus> {
    return request<TransferStatus>('/api/vault/move', { method: 'POST', body: JSON.stringify({ targetPath }) });
  },

  /** Switches to another existing Vault; follow `vaultTransferStatus`. */
  openOtherVault(path: string): Promise<TransferStatus> {
    return request<TransferStatus>('/api/vault/open', { method: 'POST', body: JSON.stringify({ path }) });
  },

  /** Cancels a Vault operation that is still waiting for collection steps. */
  cancelTransfer(): Promise<TransferStatus> {
    return request<TransferStatus>('/api/vault/cancel', { method: 'POST' });
  },
};

function filterParameters(filter: DocumentFilter): URLSearchParams {
  const parameters = new URLSearchParams();
  if (filter.sourceType) parameters.set('sourceType', filter.sourceType);
  if (filter.publisherId) parameters.set('publisherId', filter.publisherId);
  return parameters;
}

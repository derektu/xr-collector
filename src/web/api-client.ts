import type {
  BuildInfo,
  ActivityPage,
  ActivitySummaryPage,
  ActivityGroupPage,
  ActivityQuery,
  JobOverview,
  JobSummary,
  DocumentFilter,
  DocumentDeletion,
  DocumentPage,
  DocumentSources,
  JobPage,
  JobSubmission,
  JobView,
  TransferStatus,
  SavedDocument,
  SearchQuery,
  SearchResponse,
  SearchStatusReport,
  CollectionScheduleView,
  SubscriptionRecord,
  SubscriptionSettings,
  RecognitionAction,
  SubscriptionDetail,
  SubscriptionList,
  SourceTypeInfo,
  UrlRecognition,
  VaultInspection,
  NewVaultCheck,
  PackageDescription,
  VaultSetupRequest,
  ExportSuggestion,
  ImportMode,
  ImportPreview,
  VaultSetupResult,
  VaultSetupStatus,
  LoginStartupStatus,
  DeviceUpdateStatus,
  AgentConnection,
  AgentConnectionStatus,
  AgentPortSetting,
} from '../core/types.js';
import { API_ROUTES, routePath, type ApiRoute, type BodyOf, type PathParams, type QueryOf, type ResponseOf, type SubscriptionKey } from '../core/api-routes.js';

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}


/** The route of one subscription, named by its source type and its ID within the type. */
function subscriptionPath(type: string, id: string): string {
  return `/api/subscriptions/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
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

/** What calling `Route` takes: its path parameters, its JSON body and its query, each when the route has one. */
type CallInput<Route extends { path: string }> = { signal?: AbortSignal }
  & ([PathParams<Route['path']>] extends [never] ? unknown : { params: Record<PathParams<Route['path']>, string> })
  & (undefined extends BodyOf<Route> ? { body?: BodyOf<Route> } : { body: BodyOf<Route> })
  & (undefined extends QueryOf<Route> ? { query?: QueryOf<Route> } : { query: QueryOf<Route> });

/** Calls a JSON route of the API table and answers its response type. */
function call<Route extends ApiRoute<unknown, unknown, unknown> & { path: string }>(
  route: Route, ...[input]: Record<string, never> extends CallInput<Route> ? [CallInput<Route>?] : [CallInput<Route>]
): Promise<ResponseOf<Route>> {
  const given = (input ?? {}) as { signal?: AbortSignal; params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> };
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(given.query ?? {})) if (value !== undefined) parameters.set(key, String(value));
  const path = given.params ? routePath(route, given.params as never) : route.path;
  return request<ResponseOf<Route>>(parameters.size > 0 ? `${path}?${parameters.toString()}` : path, {
    method: route.method,
    ...(given.body !== undefined ? { body: JSON.stringify(given.body) } : {}),
    ...(given.signal ? { signal: given.signal } : {}),
  });
}

export const api = {
  async updateStatus(signal?: AbortSignal): Promise<DeviceUpdateStatus> {
    return (await call(API_ROUTES.update, { signal })).update;
  },
  async checkForUpdate(signal?: AbortSignal): Promise<DeviceUpdateStatus> {
    return (await call(API_ROUTES.checkUpdate, { signal })).update;
  },
  async downloadUpdate(version: string, sha256: string, signal?: AbortSignal): Promise<DeviceUpdateStatus> {
    return (await call(API_ROUTES.downloadUpdate, { body: { version, sha256 }, signal })).update;
  },
  async applyUpdate(version: string, sha256: string, signal?: AbortSignal): Promise<DeviceUpdateStatus> {
    return (await call(API_ROUTES.applyUpdate, { body: { version, sha256 }, signal })).update;
  },
  async cancelUpdate(signal?: AbortSignal): Promise<DeviceUpdateStatus> {
    return (await call(API_ROUTES.cancelUpdate, { signal })).update;
  },
  async buildInfo(signal?: AbortSignal): Promise<BuildInfo> {
    return (await call(API_ROUTES.buildInfo, { signal })).buildInfo;
  },

  async getLoginStartup(signal?: AbortSignal): Promise<LoginStartupStatus> {
    return (await call(API_ROUTES.loginStartup, { signal })).loginStartup;
  },

  async setLoginStartup(enabled: boolean, signal?: AbortSignal): Promise<LoginStartupStatus> {
    return (await call(API_ROUTES.setLoginStartup, { body: { enabled }, signal })).loginStartup;
  },

  async getVaultSetup(signal?: AbortSignal): Promise<VaultSetupStatus> {
    return (await call(API_ROUTES.vaultSetup, { signal })).vault;
  },

  async inspectVault(path: string): Promise<VaultInspection> {
    return (await call(API_ROUTES.inspectVault, { body: { path } })).inspection;
  },

  setupVault(setup: VaultSetupRequest): Promise<VaultSetupResult> {
    return call(API_ROUTES.setupVault, { body: setup });
  },

  async checkNewVault(location: string, name: string, signal?: AbortSignal): Promise<NewVaultCheck> {
    return (await call(API_ROUTES.checkNewVault, { body: { location, name }, signal })).check;
  },

  async describePackage(path: string): Promise<PackageDescription> {
    return (await call(API_ROUTES.describePackage, { body: { path } })).package;
  },

  async getAgentConnectionStatus(): Promise<AgentConnectionStatus> {
    return (await call(API_ROUTES.agent)).agent;
  },
  async agentConnection(): Promise<AgentConnection> {
    return (await call(API_ROUTES.agentConnection)).connection;
  },
  async setAgentPort(port: AgentPortSetting): Promise<AgentConnectionStatus> {
    return (await call(API_ROUTES.setAgentPort, { body: port })).agent;
  },
  async resetAgentKey(): Promise<AgentConnection> {
    return (await call(API_ROUTES.resetAgentKey)).connection;
  },
  async downloadAgentSkill(): Promise<Blob> {
    const response = await fetch(API_ROUTES.agentSkill.path);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ErrorResponse;
      throw new ApiError(body.error?.message ?? `HTTP ${response.status}`, body.error?.code ?? 'unknown_error');
    }
    return response.blob();
  },
  /** The automatic collection switch; one switch covers the subscriptions of every type. */
  async getSchedule(): Promise<CollectionScheduleView> {
    return (await call(API_ROUTES.schedule)).schedule;
  },

  /** Turns automatic collection on or off. */
  async setAutoCollection(enabled: boolean): Promise<CollectionScheduleView> {
    return (await call(API_ROUTES.setSchedule, { body: { enabled } })).schedule;
  },

  /** Saves some of one subscription's settings; fields left out keep their value. */
  async updateSubscriptionSettings(type: string, id: string, settings: Partial<SubscriptionSettings>): Promise<SubscriptionRecord> {
    const result = await request<{ subscription: SubscriptionRecord }>(subscriptionPath(type, id), {
      method: 'PATCH',
      body: JSON.stringify({ settings }),
    });
    return result.subscription;
  },

  /** Gives every other subscription of the same type this subscription's settings. */
  applySubscriptionSettings(type: string, id: string): Promise<{ updated: number; paused: number }> {
    return request<{ updated: number; paused: number }>(`${subscriptionPath(type, id)}/apply-settings`, { method: 'POST' });
  },

  async setSubscriptionEnabled(type: string, id: string, enabled: boolean): Promise<{ subscription: SubscriptionRecord; submission: JobSubmission | null }> {
    return request<{ subscription: SubscriptionRecord; submission: JobSubmission | null }>(subscriptionPath(type, id), {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  },

  /** Removes a subscription, keeping or deleting its documents. */
  async removeSubscription(type: string, id: string, documents: 'keep' | 'delete' = 'keep'): Promise<{ documentsKept: number; documentsDeleted: number; documentsFailed: number }> {
    return request<{ removed: true; documentsKept: number; documentsDeleted: number; documentsFailed: number }>(`${subscriptionPath(type, id)}?documents=${documents}`, {
      method: 'DELETE',
    });
  },

  /** Checks every enabled subscription of every type now. */
  async checkAllSubscriptions(): Promise<JobSubmission[]> {
    return (await call(API_ROUTES.checkSubscriptions)).submissions;
  },

  /** Checks the listed subscriptions now. */
  async checkSubscriptions(subscriptions: SubscriptionKey[]): Promise<JobSubmission[]> {
    return (await call(API_ROUTES.checkSubscriptions, { body: { subscriptions } })).submissions;
  },

  listJobs(query: { state?: 'active' | 'all'; limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<JobPage> {
    const parameters = new URLSearchParams();
    if (query.state) parameters.set('state', query.state);
    if (query.limit) parameters.set('limit', String(query.limit));
    if (query.cursor) parameters.set('cursor', query.cursor);
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
    return request<JobPage>(`/api/jobs${suffix}`, signal ? { signal } : undefined);
  },

  async getJob(id: string, signal?: AbortSignal): Promise<JobView> {
    return (await request<{ job: JobView }>(`/api/jobs/${encodeURIComponent(id)}`, signal ? { signal } : undefined)).job;
  },

  async jobSummary(since: string, signal?: AbortSignal): Promise<JobSummary> {
    return (await request<{ summary: JobSummary }>(`/api/jobs/summary?${new URLSearchParams({ since }).toString()}`, signal ? { signal } : undefined)).summary;
  },

  retryJob(id: string): Promise<JobSubmission> {
    return request<JobSubmission>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },

  async jobOverview(signal?: AbortSignal): Promise<JobOverview> {
    return (await call(API_ROUTES.jobOverview, { signal })).overview;
  },

  async dismissJob(id: string): Promise<JobView> {
    return (await request<{ job: JobView }>(`/api/jobs/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })).job;
  },

  activity(query: ActivityQuery, signal?: AbortSignal): Promise<ActivityPage> {
    const parameters = new URLSearchParams();
    if (query.severity) parameters.set('severity', query.severity.join(','));
    if (query.eventType) parameters.set('eventType', query.eventType.join(','));
    if (query.view) parameters.set('view', query.view);
    for (const key of ['jobId', 'subscriptionId', 'sourceType', 'since', 'until', 'cursor'] as const) {
      const value = query[key];
      if (value) parameters.set(key, value);
    }
    if (query.limit) parameters.set('limit', String(query.limit));
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
    return request<ActivityPage>(`/api/activity${suffix}`, signal ? { signal } : undefined);
  },

  activitySummary(query: ActivityQuery, signal?: AbortSignal): Promise<ActivitySummaryPage> {
    const parameters = new URLSearchParams({ view: 'summary' });
    if (query.severity) parameters.set('severity', query.severity.join(','));
    if (query.eventType) parameters.set('eventType', query.eventType.join(','));
    for (const key of ['subscriptionId', 'sourceType', 'since', 'until', 'cursor'] as const) {
      const value = query[key];
      if (value) parameters.set(key, value);
    }
    if (query.limit) parameters.set('limit', String(query.limit));
    return request<ActivitySummaryPage>(`/api/activity?${parameters.toString()}`, signal ? { signal } : undefined);
  },

  activityGroup(groupId: string, query: { limit?: number; cursor?: string; severity?: ActivityQuery['severity'] } = {}): Promise<ActivityGroupPage> {
    const parameters = new URLSearchParams();
    if (query.limit) parameters.set('limit', String(query.limit));
    if (query.cursor) parameters.set('cursor', query.cursor);
    if (query.severity) parameters.set('severity', query.severity.join(','));
    const suffix = parameters.size ? `?${parameters.toString()}` : '';
    return request<ActivityGroupPage>(`/api/activity/groups/${encodeURIComponent(groupId)}${suffix}`);
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

  /** Deletes a document; automatic and subscription collection skip it until the user collects it again by its address. */
  deleteDocument(id: string): Promise<DocumentDeletion> {
    return request<DocumentDeletion>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** Collects one item by its address; the service finds the source type the address belongs to. */
  collect(url: string): Promise<JobSubmission> {
    return request<JobSubmission>('/api/items', {
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

  /** Every subscription across source types, with pending subscription requests and unsubscribed documents. */
  listSubscriptions(signal?: AbortSignal): Promise<SubscriptionList> {
    return request<SubscriptionList>('/api/subscriptions', signal ? { signal } : undefined);
  },

  subscriptionDetail(type: string, id: string, signal?: AbortSignal): Promise<SubscriptionDetail> {
    return request<SubscriptionDetail>(subscriptionPath(type, id), signal ? { signal } : undefined);
  },

  async getSearchStatus(signal?: AbortSignal): Promise<SearchStatusReport> {
    const result = await request<{ status: SearchStatusReport }>('/api/search/status', signal ? { signal } : undefined);
    return result.status;
  },

  async rebuildSearch(): Promise<SearchStatusReport> {
    const result = await request<{ status: SearchStatusReport }>('/api/search/rebuild', {
      method: 'POST',
    });
    return result.status;
  },

  vaultTransferStatus(signal?: AbortSignal): Promise<TransferStatus> {
    return call(API_ROUTES.vaultStatus, { signal });
  },

  /** The export folder and today's export file in it. */
  exportSuggestion(): Promise<ExportSuggestion> {
    return call(API_ROUTES.exportSuggestion);
  },

  /** Writes the export of the active Vault to an absolute `.zip` path on this computer. */
  exportVault(path: string, overwrite: boolean): Promise<TransferStatus> {
    return call(API_ROUTES.exportVault, { body: { path, overwrite } });
  },

  /** Compares an export file with the active Vault. */
  previewImport(path: string): Promise<ImportPreview> {
    return call(API_ROUTES.previewImport, { body: { path } });
  },

  /** Applies a compared import; follow `vaultTransferStatus`. */
  applyImport(id: string, mode: ImportMode): Promise<TransferStatus> {
    return call(API_ROUTES.applyImport, { body: { id, mode } });
  },

  async cancelImport(id: string): Promise<void> {
    await call(API_ROUTES.cancelImport, { body: { id } });
  },

  /** Switches to another existing Vault; follow `vaultTransferStatus`. */
  openOtherVault(path: string): Promise<TransferStatus> {
    return call(API_ROUTES.openVault, { body: { path } });
  },

  createVault(location: string, name: string): Promise<TransferStatus> {
    return call(API_ROUTES.createVault, { body: { location, name } });
  },

  /** Cancels a Vault operation that is still waiting for collection steps. */
  cancelTransfer(): Promise<TransferStatus> {
    return call(API_ROUTES.cancelVaultWait);
  },
};

function filterParameters(filter: DocumentFilter): URLSearchParams {
  const parameters = new URLSearchParams();
  if (filter.sourceType) parameters.set('sourceType', filter.sourceType);
  if (filter.publisherId) parameters.set('publisherId', filter.publisherId);
  return parameters;
}

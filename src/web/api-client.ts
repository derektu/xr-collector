import type { BuildInfo, DeviceUpdateStatus } from '../core/update-types.js';
import type { ActivityPage, ActivitySummaryPage, ActivityGroupPage, ActivityQuery } from '../core/activity-types.js';
import type { JobOverview, JobSummary, JobPage, JobSubmission, JobView } from '../core/job-types.js';
import type {
  DocumentFilter,
  DocumentDeletion,
  DocumentPage,
  DocumentSources,
  SavedDocument,
} from '../core/document-types.js';
import type {
  TransferStatus,
  VaultInspection,
  NewVaultCheck,
  PackageDescription,
  VaultSetupRequest,
  ExportSuggestion,
  ImportMode,
  ImportPreview,
  VaultSetupResult,
  VaultSetupStatus,
} from '../core/vault-types.js';
import type { SearchQuery, SearchResponse, SearchStatusReport } from '../core/search-types.js';
import type {
  CollectionScheduleView,
  SubscriptionRecord,
  SubscriptionSettings,
  SubscriptionDetail,
  SubscriptionList,
} from '../core/subscription-types.js';
import type { RecognitionAction, SourceTypeInfo, UrlRecognition } from '../core/source-info-types.js';
import type {
  LoginStartupStatus,
  AgentConnection,
  AgentConnectionStatus,
  AgentPortSetting,
} from '../core/device-types.js';
import { API_ROUTES, routePath, type ApiRoute, type BodyOf, type PathParams, type QueryOf, type ResponseOf, type SubscriptionKey, type ActivityParameters } from '../core/api-routes.js';

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

async function request(path: string, init?: RequestInit): Promise<unknown> {
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
  return response.json() as Promise<unknown>;
}

/** What calling `Route` takes: its path parameters, its JSON body and its query, each when the route has one. */
type CallInput<Route extends { path: string }> = { signal?: AbortSignal }
  & ([PathParams<Route['path']>] extends [never] ? unknown : { params: Record<PathParams<Route['path']>, string> })
  & (undefined extends BodyOf<Route> ? { body?: BodyOf<Route> } : { body: BodyOf<Route> })
  & (undefined extends QueryOf<Route> ? { query?: QueryOf<Route> } : Record<string, never> extends QueryOf<Route> ? { query?: QueryOf<Route> } : { query: QueryOf<Route> });

/** Calls a JSON route of the API table and answers its response type. */
function call<Route extends ApiRoute<unknown, unknown, unknown> & { path: string }>(
  route: Route, ...[input]: Record<string, never> extends CallInput<Route> ? [CallInput<Route>?] : [CallInput<Route>]
): Promise<ResponseOf<Route>> {
  const given = (input ?? {}) as { signal?: AbortSignal; params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> };
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(given.query ?? {})) if (value !== undefined) parameters.set(key, String(value));
  const path = given.params ? routePath(route, given.params as never) : route.path;
  return request(parameters.size > 0 ? `${path}?${parameters.toString()}` : path, {
    method: route.method,
    ...(given.body !== undefined ? { body: JSON.stringify(given.body) } : {}),
    ...(given.signal ? { signal: given.signal } : {}),
  }) as Promise<ResponseOf<Route>>;
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
    return (await call(API_ROUTES.updateSubscription, { params: { type, id }, body: { settings } })).subscription;
  },

  /** Gives every other subscription of the same type this subscription's settings. */
  applySubscriptionSettings(type: string, id: string): Promise<{ updated: number; paused: number }> {
    return call(API_ROUTES.applySubscriptionSettings, { params: { type, id } });
  },

  async setSubscriptionEnabled(type: string, id: string, enabled: boolean): Promise<{ subscription: SubscriptionRecord; submission: JobSubmission | null }> {
    return call(API_ROUTES.updateSubscription, { params: { type, id }, body: { enabled } });
  },

  /** Removes a subscription, keeping or deleting its documents. */
  async removeSubscription(type: string, id: string, documents: 'keep' | 'delete' = 'keep'): Promise<{ documentsKept: number; documentsDeleted: number; documentsFailed: number }> {
    return call(API_ROUTES.removeSubscription, { params: { type, id }, query: { documents } });
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
    return call(API_ROUTES.jobs, { query: { state: query.state || undefined, limit: query.limit || undefined, cursor: query.cursor || undefined }, signal });
  },

  async getJob(id: string, signal?: AbortSignal): Promise<JobView> {
    return (await call(API_ROUTES.job, { params: { id }, signal })).job;
  },

  async jobSummary(since: string, signal?: AbortSignal): Promise<JobSummary> {
    return (await call(API_ROUTES.jobSummary, { query: { since }, signal })).summary;
  },

  retryJob(id: string): Promise<JobSubmission> {
    return call(API_ROUTES.retryJob, { params: { id } });
  },

  async jobOverview(signal?: AbortSignal): Promise<JobOverview> {
    return (await call(API_ROUTES.jobOverview, { signal })).overview;
  },

  async dismissJob(id: string): Promise<JobView> {
    return (await call(API_ROUTES.dismissJob, { params: { id } })).job;
  },

  async activity(query: ActivityQuery, signal?: AbortSignal): Promise<ActivityPage> {
    const page = await call(API_ROUTES.activity, { query: { ...activityParameters(query), jobId: query.jobId || undefined, view: query.view || undefined }, signal });
    if (!('events' in page)) throw new Error('The activity log answered a summary page to a raw query.');
    return page;
  },

  async activitySummary(query: ActivityQuery, signal?: AbortSignal): Promise<ActivitySummaryPage> {
    const page = await call(API_ROUTES.activity, { query: { ...activityParameters(query), view: 'summary' }, signal });
    if (!('entries' in page)) throw new Error('The activity log answered a raw page to a summary query.');
    return page;
  },

  activityGroup(groupId: string, query: { limit?: number; cursor?: string; severity?: ActivityQuery['severity'] } = {}): Promise<ActivityGroupPage> {
    return call(API_ROUTES.activityGroup, { params: { groupId }, query: {
      limit: query.limit || undefined, cursor: query.cursor || undefined, severity: query.severity?.join(','),
    } });
  },

  listDocuments(query: DocumentFilter & { offset: number; limit: number }, signal?: AbortSignal): Promise<DocumentPage> {
    return call(API_ROUTES.documents, { query: { ...filterParameters(query), offset: query.offset, limit: query.limit }, signal });
  },

  async documentSources(signal?: AbortSignal): Promise<DocumentSources> {
    return (await call(API_ROUTES.documentSources, { signal })).sources;
  },

  async readDocument(id: string, signal?: AbortSignal): Promise<SavedDocument> {
    return (await call(API_ROUTES.document, { params: { id }, signal })).document;
  },

  /** Deletes a document; automatic and subscription collection skip it until the user collects it again by its address. */
  deleteDocument(id: string): Promise<DocumentDeletion> {
    return call(API_ROUTES.deleteDocument, { params: { id } });
  },

  /** Collects one item by its address; the service finds the source type the address belongs to. */
  collect(url: string): Promise<JobSubmission> {
    return call(API_ROUTES.collectItem, { body: { url } });
  },

  searchDocuments(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> {
    return call(API_ROUTES.search, { query: {
      ...filterParameters(query), q: query.query, publishedFrom: query.publishedFrom || undefined, publishedTo: query.publishedTo || undefined,
      offset: query.offset, limit: query.limit,
    }, signal });
  },

  async sourceTypes(): Promise<SourceTypeInfo[]> {
    return (await call(API_ROUTES.sourceTypes)).sourceTypes;
  },

  async recognizeUrl(url: string, signal?: AbortSignal): Promise<UrlRecognition> {
    return (await call(API_ROUTES.recognizeUrl, { body: { url }, signal })).recognition;
  },

  /** Sends the request a recognized address offers, exactly as the service described it. */
  performAction(action: RecognitionAction): Promise<unknown> {
    return request(action.request.path, { method: action.request.method, body: JSON.stringify(action.request.body) });
  },

  /** Every subscription across source types, with pending subscription requests and unsubscribed documents. */
  listSubscriptions(signal?: AbortSignal): Promise<SubscriptionList> {
    return call(API_ROUTES.subscriptions, { signal });
  },

  subscriptionDetail(type: string, id: string, signal?: AbortSignal): Promise<SubscriptionDetail> {
    return call(API_ROUTES.subscription, { params: { type, id }, signal });
  },

  async getSearchStatus(signal?: AbortSignal): Promise<SearchStatusReport> {
    return (await call(API_ROUTES.searchStatus, { signal })).status;
  },

  async rebuildSearch(): Promise<SearchStatusReport> {
    return (await call(API_ROUTES.rebuildSearch)).status;
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

function filterParameters(filter: DocumentFilter): { sourceType: string | undefined; publisherId: string | undefined } {
  return { sourceType: filter.sourceType || undefined, publisherId: filter.publisherId || undefined };
}

/** The filters both activity views take. */
function activityParameters(query: ActivityQuery): ActivityParameters {
  return {
    severity: query.severity?.join(','), eventType: query.eventType?.join(','),
    subscriptionId: query.subscriptionId || undefined, sourceType: query.sourceType || undefined, since: query.since || undefined,
    until: query.until || undefined, cursor: query.cursor || undefined, limit: query.limit || undefined,
  };
}

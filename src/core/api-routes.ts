// The HTTP API as one table the server registers from and the clients call through: each route's
// method, path, Vault access and the types of its request and response. A response key the server
// renames no longer matches the type its clients read, so the change fails the typecheck instead of
// reaching a screen as `undefined`.
import type { ChangeBatch } from './changes.js';
import type { ActivityLogHealth, ActivityGroupPage, ActivityPage, ActivitySummaryPage } from './activity-types.js';
import type {
  AgentConnection,
  AgentConnectionStatus,
  AgentPortSetting,
  CollectorRuntimeStatus,
  ConnectivityStatus,
  LoginStartupStatus,
  NotificationState,
} from './device-types.js';
import type { BuildInfo, DeviceUpdateStatus, UpdateSelection } from './update-types.js';
import type {
  CollectionScheduleView,
  SubscriptionDetail,
  SubscriptionList,
  SubscriptionPreview,
  SubscriptionRecord,
  SubscriptionSettings,
} from './subscription-types.js';
import type {
  ExportSuggestion,
  ImportMode,
  ImportPreview,
  NewVaultCheck,
  PackageDescription,
  TransferStatus,
  VaultInspection,
  VaultSetupRequest,
  VaultSetupResult,
  VaultSetupStatus,
} from './vault-types.js';
import type { JobOverview, JobSubmission, PacingStatus, JobPage, JobSummary, JobView } from './job-types.js';
import type { DocumentDeletion, DocumentPage, DocumentSources, SavedDocument } from './document-types.js';
import type { SearchResponse, SearchStatusReport } from './search-types.js';
import type { SourceTypeInfo, UrlRecognition } from './source-info-types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How a route meets the Vault. `device-data` reads or changes state outside the Vault, so it answers
 * before a Vault is ready and during Vault operations; `vault-operation` is an export, import, open or
 * create, which takes the Vault lock as an operation. A route without one answers `vault_not_ready`
 * until a Vault is ready and takes the Vault lock: a GET to read, others to write.
 */
export type RouteVaultAccess = 'device-data' | 'vault-operation';

declare const shapes: unique symbol;

export interface ApiRoute<Response = unknown, Body = undefined, Query = undefined> {
  readonly method: HttpMethod;
  /** The path, with `:name` for each path parameter. */
  readonly path: string;
  readonly access?: RouteVaultAccess;
  /** The status of a successful answer; 200 when left out. */
  readonly status?: number;
  /**
   * Types only, never present at run time. A route that answers an event stream or a file has the
   * response type `never`.
   */
  readonly [shapes]?: { response: Response; body: Body; query: Query };
}

export type ResponseOf<R> = R extends ApiRoute<infer Response, unknown, unknown> ? Response : never;
export type BodyOf<R> = R extends ApiRoute<unknown, infer Body, unknown> ? Body : never;
export type QueryOf<R> = R extends ApiRoute<unknown, unknown, infer Query> ? Query : never;

/** The names of a path's `:name` parameters. */
export type PathParams<Path extends string> =
  Path extends `${string}:${infer Name}/${infer Rest}` ? Name | PathParams<`/${Rest}`>
    : Path extends `${string}:${infer Name}` ? Name : never;

interface RouteFields<Method extends HttpMethod, Path extends string> {
  method: Method; path: Path; access?: RouteVaultAccess; status?: number;
}

/** A JSON route answering `Response`, taking a JSON `Body` and a `Query` when given. */
function json<Response, Body = undefined, Query = undefined>() {
  return <const Method extends HttpMethod, const Path extends string>(fields: RouteFields<Method, Path>)
    : ApiRoute<Response, Body, Query> & { readonly method: Method; readonly path: Path } =>
    Object.freeze({ ...fields });
}

/** A route answering an event stream or a file instead of JSON. */
function unformatted<const Method extends HttpMethod, const Path extends string>(fields: RouteFields<Method, Path>)
  : ApiRoute<never> & { readonly method: Method; readonly path: Path } {
  return Object.freeze({ ...fields });
}

export interface HealthResponse {
  status: 'ok' | 'unavailable';
  runtime?: CollectorRuntimeStatus;
  connectivity: ConnectivityStatus;
  activityLog?: ActivityLogHealth;
}
export interface ChangesQuery { after?: string; wait?: number; kind?: string; id?: string }
export interface ChangesResponse { revision: string; reset: boolean; batches: ChangeBatch[] }
export interface PacingGroupStatus extends PacingStatus { group: string; label: string }
export interface EnabledSetting { enabled: boolean }
export interface PathRequest { path: string }
export interface NewVaultRequest { location: string; name: string }
export interface SubscriptionKey { type: string; id: string }
export interface UrlRequest { url: string }
export interface DocumentQuery { sourceType?: string; publisherId?: string; offset?: number; limit?: number }
export interface SearchParameters extends DocumentQuery { q: string; publishedFrom?: string; publishedTo?: string }
export interface JobListQuery { state?: 'active' | 'all'; limit?: number; cursor?: string }
/** Severities and event types are comma separated. */
export interface ActivityParameters {
  view?: 'raw' | 'summary'; severity?: string; eventType?: string; jobId?: string; subscriptionId?: string;
  sourceType?: string; since?: string; until?: string; cursor?: string; limit?: number;
}
export interface ActivityGroupQuery { limit?: number; cursor?: string; severity?: string }
export interface SubscriptionChange { enabled?: boolean; settings?: Partial<SubscriptionSettings> }
export interface SubscriptionRemoval { removed: true; documentsKept: number; documentsDeleted: number; documentsFailed: number }

/**
 * Every route the table declares. The server registers each one with its access and status; the web
 * client and the system tray call them by name.
 */
export const API_ROUTES = {
  events: unformatted({ method: 'GET', path: '/api/events', access: 'device-data' }),
  changes: json<ChangesResponse, undefined, ChangesQuery>()({ method: 'GET', path: '/api/changes', access: 'device-data' }),
  health: json<HealthResponse>()({ method: 'GET', path: '/api/health', access: 'device-data' }),
  pacing: json<{ groups: PacingGroupStatus[] }>()({ method: 'GET', path: '/api/pacing', access: 'device-data' }),

  buildInfo: json<{ buildInfo: BuildInfo }>()({ method: 'GET', path: '/api/device/build-info', access: 'device-data' }),
  notifications: json<{ notifications: NotificationState }>()({ method: 'GET', path: '/api/device/notifications', access: 'device-data' }),
  setNotifications: json<{ notifications: NotificationState }, EnabledSetting>()({ method: 'PUT', path: '/api/device/notifications', access: 'device-data' }),
  update: json<{ update: DeviceUpdateStatus }>()({ method: 'GET', path: '/api/device/updates', access: 'device-data' }),
  checkUpdate: json<{ update: DeviceUpdateStatus }>()({ method: 'POST', path: '/api/device/updates/check', access: 'device-data' }),
  downloadUpdate: json<{ update: DeviceUpdateStatus }, UpdateSelection>()({ method: 'POST', path: '/api/device/updates/download', access: 'device-data' }),
  applyUpdate: json<{ update: DeviceUpdateStatus }, UpdateSelection>()({ method: 'POST', path: '/api/device/updates/apply', access: 'device-data' }),
  cancelUpdate: json<{ update: DeviceUpdateStatus }>()({ method: 'POST', path: '/api/device/updates/cancel', access: 'device-data' }),
  loginStartup: json<{ loginStartup: LoginStartupStatus }>()({ method: 'GET', path: '/api/device/login-startup', access: 'device-data' }),
  setLoginStartup: json<{ loginStartup: LoginStartupStatus }, EnabledSetting>()({ method: 'PUT', path: '/api/device/login-startup', access: 'device-data' }),
  agent: json<{ agent: AgentConnectionStatus }>()({ method: 'GET', path: '/api/device/agent', access: 'device-data' }),
  agentConnection: json<{ connection: AgentConnection }>()({ method: 'GET', path: '/api/device/agent/connection', access: 'device-data' }),
  setAgentPort: json<{ agent: AgentConnectionStatus }, AgentPortSetting>()({ method: 'PUT', path: '/api/device/agent/port', access: 'device-data' }),
  resetAgentKey: json<{ connection: AgentConnection; agent: AgentConnectionStatus }>()({ method: 'POST', path: '/api/device/agent/key/reset', access: 'device-data' }),
  agentSkill: unformatted({ method: 'GET', path: '/api/device/agent/skill', access: 'device-data' }),

  vaultSetup: json<{ vault: VaultSetupStatus }>()({ method: 'GET', path: '/api/vault/setup', access: 'device-data' }),
  setupVault: json<VaultSetupResult, VaultSetupRequest>()({ method: 'POST', path: '/api/vault/setup', access: 'device-data' }),
  inspectVault: json<{ inspection: VaultInspection }, PathRequest>()({ method: 'POST', path: '/api/vault/inspect', access: 'device-data' }),
  checkNewVault: json<{ check: NewVaultCheck }, NewVaultRequest>()({ method: 'POST', path: '/api/vault/new/check', access: 'device-data' }),
  describePackage: json<{ package: PackageDescription }, PathRequest>()({ method: 'POST', path: '/api/vault/package/describe', access: 'device-data' }),
  vaultStatus: json<TransferStatus>()({ method: 'GET', path: '/api/vault/status', access: 'device-data' }),
  exportSuggestion: json<ExportSuggestion>()({ method: 'GET', path: '/api/vault/export/suggestion', access: 'vault-operation' }),
  exportVault: json<TransferStatus, PathRequest & { overwrite: boolean }>()({ method: 'POST', path: '/api/vault/export', access: 'vault-operation' }),
  previewImport: json<ImportPreview, PathRequest>()({ method: 'POST', path: '/api/vault/import/preview', access: 'vault-operation' }),
  applyImport: json<TransferStatus, { id: string; mode: ImportMode }>()({ method: 'POST', path: '/api/vault/import/apply', access: 'vault-operation', status: 202 }),
  cancelImport: json<{ cancelled: true }, { id: string }>()({ method: 'POST', path: '/api/vault/import/cancel', access: 'vault-operation' }),
  cancelVaultWait: json<TransferStatus>()({ method: 'POST', path: '/api/vault/cancel', access: 'vault-operation' }),
  openVault: json<TransferStatus, PathRequest>()({ method: 'POST', path: '/api/vault/open', access: 'vault-operation', status: 202 }),
  createVault: json<TransferStatus, NewVaultRequest>()({ method: 'POST', path: '/api/vault/create', access: 'vault-operation', status: 202 }),

  jobOverview: json<{ overview: JobOverview }>()({ method: 'GET', path: '/api/jobs/overview', access: 'device-data' }),
  schedule: json<{ schedule: CollectionScheduleView }>()({ method: 'GET', path: '/api/schedule' }),
  setSchedule: json<{ schedule: CollectionScheduleView }, EnabledSetting>()({ method: 'PUT', path: '/api/schedule' }),
  checkSubscriptions: json<{ submissions: JobSubmission[] }, { subscriptions: SubscriptionKey[] } | undefined>()({ method: 'POST', path: '/api/subscription-checks', status: 202 }),

  documents: json<DocumentPage, undefined, DocumentQuery>()({ method: 'GET', path: '/api/documents' }),
  documentSources: json<{ sources: DocumentSources }>()({ method: 'GET', path: '/api/documents/sources' }),
  document: json<{ document: SavedDocument }>()({ method: 'GET', path: '/api/documents/:id' }),
  deleteDocument: json<DocumentDeletion>()({ method: 'DELETE', path: '/api/documents/:id' }),
  search: json<SearchResponse, undefined, SearchParameters>()({ method: 'GET', path: '/api/search' }),
  searchStatus: json<{ status: SearchStatusReport }>()({ method: 'GET', path: '/api/search/status' }),
  rebuildSearch: json<{ status: SearchStatusReport }>()({ method: 'POST', path: '/api/search/rebuild' }),

  submitAddress: json<JobSubmission, UrlRequest>()({ method: 'POST', path: '/api/submissions', status: 202 }),
  collectItem: json<JobSubmission, UrlRequest>()({ method: 'POST', path: '/api/items', status: 202 }),
  jobs: json<JobPage, undefined, JobListQuery>()({ method: 'GET', path: '/api/jobs', access: 'device-data' }),
  jobSummary: json<{ summary: JobSummary }, undefined, { since?: string }>()({ method: 'GET', path: '/api/jobs/summary', access: 'device-data' }),
  job: json<{ job: JobView }>()({ method: 'GET', path: '/api/jobs/:id', access: 'device-data' }),
  retryJob: json<JobSubmission>()({ method: 'POST', path: '/api/jobs/:id/retry', status: 202 }),
  dismissJob: json<{ job: JobView }>()({ method: 'POST', path: '/api/jobs/:id/dismiss' }),
  /**
   * The response's `view` names what it holds: `summary` for an `ActivitySummaryPage`, `raw` for an
   * `ActivityPage`. A `summary` query answers raw events when it names a job.
   */
  activity: json<ActivityPage | ActivitySummaryPage, undefined, ActivityParameters>()({ method: 'GET', path: '/api/activity', access: 'device-data' }),
  activityGroup: json<ActivityGroupPage, undefined, ActivityGroupQuery>()({ method: 'GET', path: '/api/activity/groups/:groupId', access: 'device-data' }),

  sourceTypes: json<{ sourceTypes: SourceTypeInfo[] }>()({ method: 'GET', path: '/api/source-types' }),
  recognizeUrl: json<{ recognition: UrlRecognition }, UrlRequest>()({ method: 'POST', path: '/api/url-recognitions' }),
  previewSubscription: json<{ preview: SubscriptionPreview }, UrlRequest>()({ method: 'POST', path: '/api/subscription-previews' }),
  subscribe: json<JobSubmission, UrlRequest & { settings?: Partial<SubscriptionSettings> }>()({ method: 'POST', path: '/api/subscriptions', status: 202 }),
  subscriptions: json<SubscriptionList, undefined, { type?: string }>()({ method: 'GET', path: '/api/subscriptions' }),
  subscription: json<SubscriptionDetail>()({ method: 'GET', path: '/api/subscriptions/:type/:id' }),
  updateSubscription: json<{ subscription: SubscriptionRecord; submission: JobSubmission | null }, SubscriptionChange>()({ method: 'PATCH', path: '/api/subscriptions/:type/:id' }),
  applySubscriptionSettings: json<{ updated: number; paused: number }>()({ method: 'POST', path: '/api/subscriptions/:type/:id/apply-settings' }),
  removeSubscription: json<SubscriptionRemoval, undefined, { documents?: 'keep' | 'delete' }>()({ method: 'DELETE', path: '/api/subscriptions/:type/:id' }),
} as const;

export type ApiRouteName = keyof typeof API_ROUTES;

/** The path of `route` with each `:name` replaced by its encoded value in `params`. */
export function routePath<Path extends string>(route: { path: Path }, params: Record<PathParams<Path>, string>): string {
  return route.path.replace(/:(\w+)/gu, (_match, name: string) => encodeURIComponent((params as Record<string, string>)[name]!));
}

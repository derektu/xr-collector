import type { VaultWorkspace } from '../vault/workspace.js';
import type { YouTubePacing } from '../capture/youtube-gate.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Collector } from '../core/collector.js';
import type { CollectorRuntimeStatus } from '../runtime/collector-runtime.js';
import { parsePolicyPatch } from '../channels/collection-policy.js';
import { SourceCatalog } from '../sources/source-catalog.js';
import { recognizeUrl, SOURCE_TYPES, sourceTypeInfo, type SourceTypeDeclaration } from '../sources/source-types.js';
import {
  CollectorError,
  type ActivityLogHealth,
  type ActivityPage,
  type ActivityQuery,
  type EventSeverity,
  type JobSummary,
  type CollectionJob,
  type JobPage,
  type JobSubmission,
  type ChannelSchedule,
  type DocumentFilter,
  type DocumentSourceType,
  type SearchStatusReport,
  type TranscriptSearch,
  type VaultInspection,
  type VaultSetupAction,
  type VaultSetupResult,
  type VaultSetupStatus,
  type ChannelPreview,
  type CollectionPolicy,
  type PendingSubscription,
  type Subscription,
  type YouTubeChannel,
} from '../core/types.js';

export interface ChannelCollection {
  listChannels(): Promise<YouTubeChannel[]>;
  listSubscriptions(): Promise<Subscription[]>;
  preview(url: string): Promise<ChannelPreview>;
  addChannel(url: string, settings?: Partial<CollectionPolicy>): Promise<JobSubmission>;
  setChannelEnabled(id: string, enabled: boolean): Promise<{ channel: YouTubeChannel; submission: JobSubmission | null }>;
  updateSettings(id: string, patch: Partial<CollectionPolicy>): Promise<YouTubeChannel>;
  applySettingsToAll(id: string): Promise<{ updated: number; paused: number }>;
  removeChannel(id: string, options?: { documents?: 'keep' | 'delete' }): Promise<{ documentsKept: number; documentsDeleted: number; documentsFailed: number }>;
  /** Subscription requests still resolving their channel. */
  pendingSubscriptions?(): Promise<PendingSubscription[]>;
  /** Subscriptions removed and not added again. */
  listRemovals?(): Promise<Array<{ id: string; title: string }>>;
  startRun(request: { trigger: 'manual'; channelIds?: string[] }): Promise<JobSubmission[]>;
  channelJobs(id: string): CollectionJob[];
}

/** Accepts collection work and answers job queries for the active Vault. */
export interface CollectionJobs {
  submit(url: string): Promise<JobSubmission>;
  submitVideo(url: string): Promise<JobSubmission>;
  get(id: string): CollectionJob;
  list(query: { state?: 'active' | 'all'; limit?: number; cursor?: string }): JobPage;
  summary(since: string): JobSummary;
  retry(id: string): Promise<JobSubmission>;
}

/** The device activity log, scoped to the active Vault; readable whatever state the Vault is in. */
export interface ActivityAccess {
  query(query: ActivityQuery): Promise<ActivityPage>;
  health(): ActivityLogHealth;
}

export interface ChannelScheduleManagement {
  getSchedule(): Promise<ChannelSchedule>;
  updateSchedule(input: { enabled: boolean }): Promise<ChannelSchedule>;
  /** Checks every enabled subscription now. */
  runNow(): Promise<JobSubmission[]>;
}

const SCHEDULE_FIELDS = new Set(['enabled']);

/** Vault location operations that stay available before a Vault is active. */
export interface VaultSetup {
  status(): VaultSetupStatus;
  inspect(path: string): Promise<VaultInspection>;
  setup(action: VaultSetupAction, path: string, packagePath?: string): Promise<VaultSetupResult>;
}

/** Routes a not-ready runtime still serves so UI and Agents can finish setup. */
const NOT_READY_ROUTES = new Set([
  '/api/health', '/api/agent/connection', '/api/vault/setup', '/api/vault/inspect', '/api/activity', '/api/youtube/pacing',
]);

export interface HttpAppOptions {
  collector?: Collector;
  jobs?: CollectionJobs;
  activity?: ActivityAccess;
  transfer?: VaultWorkspace;
  channels?: ChannelCollection;
  schedule?: ChannelScheduleManagement;
  search?: TranscriptSearch;
  /** The device's YouTube request channel; readable whatever state the Vault is in. */
  pacing?: YouTubePacing;
  webRoot?: string;
  agentToken?: string;
  agentInfo?: { connectionFile: string; skillPath: string; url: string };
  runtimeStatus?: () => CollectorRuntimeStatus;
  /** Returns why business routes are unavailable, or null once a Vault is active. */
  notReady?: () => string | null;
  vaultSetup?: VaultSetup;
  /** Source types the service offers; tests replace them to exercise other declarations. */
  sourceTypes?: SourceTypeDeclaration[];
  /**
   * Host names a request may address, each accepted only with the port this server listens on;
   * other Host headers get 403. Unset, every Host is accepted.
   */
  allowedHosts?: string[];
}

const DOCUMENT_SOURCE_TYPES: DocumentSourceType[] = ['youtube'];

const appDrains = new WeakMap<FastifyInstance, () => Promise<void>>();

export function waitForHttpAppIdle(app: FastifyInstance): Promise<void> {
  return appDrains.get(app)?.() ?? Promise.resolve();
}

const ERROR_STATUS: Record<CollectorError['code'], number> = {
  vault_busy: 409,
  vault_not_ready: 503,
  vault_invalid: 422,
  vault_already_set: 409,
  invalid_url: 400,
  invalid_channel: 400,
  invalid_request: 400,
  document_not_found: 404,
  document_deleted: 404,
  search_unavailable: 503,
  channel_not_found: 404,
  channel_paused: 409,
  out_of_range: 422,
  job_not_found: 404,
  job_not_retryable: 409,
  unsupported_url: 400,
  queue_full: 503,
  file_exists: 409,
  transfer_cancelled: 409,
  vault_location_fixed: 409,
  insufficient_space: 507,
  no_subtitles: 422,
  video_unavailable: 422,
  capture_failed: 502,
  network_error: 503,
  rate_limited: 503,
};

export async function createHttpApp(options: HttpAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  let activeRequests = 0;
  const idleWaiters = new Set<() => void>();
  appDrains.set(app, () => activeRequests === 0 ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.add(resolve)));
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const handler = route.handler;
    route.handler = async function trackedHandler(request, reply) {
      activeRequests += 1;
      try {
        return await handler.call(this, request, reply);
      } finally {
        activeRequests -= 1;
        if (activeRequests === 0) {
          for (const resolve of idleWaiters) resolve();
          idleWaiters.clear();
        }
      }
    };
  });

  if (options.allowedHosts) {
    // Any page this computer opens can reach a server on the loopback interface. A page on another
    // site that rebinds its own name to 127.0.0.1 still sends that name in Host, so accepting only
    // the server's own names keeps such pages out of the UI's unauthenticated routes.
    const names = options.allowedHosts;
    app.addHook('onRequest', async (request, reply) => {
      const address = app.server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      const host = (request.headers.host ?? '').toLowerCase();
      if (port === null || !names.some((name) => host === `${name}:${port}`)) {
        return reply.code(403).send({ error: { code: 'forbidden_host', message: '請以 127.0.0.1 或 localhost 加上服務的埠號連線。' } });
      }
    });
  }

  if (options.agentToken !== undefined) {
    if (!options.agentToken) throw new Error('Agent token must not be empty');
    const expected = Buffer.from(`Bearer ${options.agentToken}`);
    app.addHook('onRequest', async (request, reply) => {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return reply.code(401).header('WWW-Authenticate', 'Bearer').send({
          error: { code: 'unauthorized', message: '請使用目前連線檔中的 Agent token。' },
        });
      }
    });
  }

  if (options.notReady) {
    const notReady = options.notReady;
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/') || NOT_READY_ROUTES.has(request.routeOptions.url ?? '')) return;
      const message = notReady();
      if (message) {
        return reply.code(503).send({ error: { code: 'vault_not_ready', message } });
      }
    });
  }

  if (options.vaultSetup) {
    const vaultSetup = options.vaultSetup;
    app.get('/api/vault/setup', async () => ({ vault: vaultSetup.status() }));
    app.post<{ Body: { path?: unknown } }>('/api/vault/inspect', async (request) => {
      if (typeof request.body?.path !== 'string' || request.body.path.trim() === '') {
        throw new CollectorError('invalid_request', '請提供要檢查的目錄路徑。');
      }
      return { inspection: await vaultSetup.inspect(request.body.path) };
    });
    app.post<{ Body: { action?: unknown; path?: unknown; packagePath?: unknown } }>('/api/vault/setup', async (request) => {
      const { action, path: vaultPath, packagePath } = request.body ?? {};
      if ((action !== 'create' && action !== 'open' && action !== 'import') || typeof vaultPath !== 'string' || vaultPath.trim() === '') {
        throw new CollectorError('invalid_request', '請提供 action（create、open 或 import）與知識庫目錄路徑。');
      }
      if (action === 'import' && (typeof packagePath !== 'string' || packagePath.trim() === '')) {
        throw new CollectorError('invalid_request', '從匯出檔建立知識庫時，請提供匯出檔的完整路徑 packagePath。');
      }
      return vaultSetup.setup(action, vaultPath, typeof packagePath === 'string' ? packagePath : undefined);
    });
  }

  if (options.transfer) {
    const transfer = options.transfer;
    const writes = new WeakMap<object, () => void>();
    app.addHook('preHandler', async (request) => {
      if (['GET', 'HEAD'].includes(request.method) && request.url.startsWith('/api/')
        && request.routeOptions.url !== '/api/vault/status'
        // Jobs and activity are device data and stay readable while a merge holds the Vault.
        && !request.routeOptions.url?.startsWith('/api/jobs')
        && request.routeOptions.url !== '/api/activity'
        && !NOT_READY_ROUTES.has(request.routeOptions.url ?? '')) transfer.assertReadable();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)
        && !request.routeOptions.url?.startsWith('/api/vault/')) {
        writes.set(request, transfer.enterWrite());
      }
    });
    app.addHook('onResponse', async (request) => { writes.get(request)?.(); });
    app.addHook('onSend', async (request, _reply, payload) => { writes.get(request)?.(); return payload; });
    app.addHook('onError', async (request) => { writes.get(request)?.(); });
    app.get('/api/vault/status', async () => transfer.status());
    // Export and import name local files by absolute path. JSON requests need a CORS preflight,
    // which this server never grants, so only the app's own pages and authorized Agents can name files.
    app.get('/api/vault/export/suggestion', async () => transfer.exportSuggestion());
    app.post<{ Body: { path?: unknown; overwrite?: unknown } | undefined }>('/api/vault/export', async (request) => {
      return transfer.exportTo(request.body?.path, request.body?.overwrite === true);
    });
    app.post<{ Body: { path?: unknown } | undefined }>('/api/vault/import/preview', async (request) => transfer.previewImport(request.body?.path));
    app.post<{ Body: { id?: unknown; mode?: unknown } | undefined }>('/api/vault/import/apply', async (request, reply) => {
      return reply.code(202).send(transfer.applyImport(String(request.body?.id ?? ''), request.body?.mode));
    });
    app.post<{ Body: { id?: unknown } | undefined }>('/api/vault/import/cancel', async (request) => {
      transfer.cancelImport(String(request.body?.id ?? ''));
      return { cancelled: true };
    });
    app.post('/api/vault/cancel', async () => transfer.cancelWait());
    app.post<{ Body: { targetPath?: unknown } | undefined }>('/api/vault/move/check', async (request) => transfer.checkMove(request.body?.targetPath));
    app.post<{ Body: { targetPath?: unknown } | undefined }>('/api/vault/move', async (request, reply) => {
      return reply.code(202).send(await transfer.move(request.body?.targetPath));
    });
    app.post<{ Body: { path?: unknown } | undefined }>('/api/vault/open', async (request, reply) => {
      return reply.code(202).send(await transfer.openOther(request.body?.path));
    });
  }

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CollectorError) {
      if (error.retryAt) {
        const seconds = Math.max(1, Math.ceil((new Date(error.retryAt).getTime() - Date.now()) / 1000));
        void reply.header('Retry-After', String(seconds));
      }
      void reply.status(ERROR_STATUS[error.code]).send({
        error: { code: error.code, message: error.message, ...(error.retryAt ? { retryAt: error.retryAt } : {}) },
      });
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) {
      void reply.status(413).send({ error: { code: 'invalid_request', message: '請求內容過大。' } });
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 415) {
      void reply.status(415).send({ error: { code: 'invalid_request', message: '請以 JSON 送出請求；檔案以本機的完整路徑指定。' } });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({
      error: { code: 'internal_error', message: '發生未預期的錯誤。' },
    });
  });

  app.get('/api/health', async () => {
    const runtime = options.runtimeStatus?.();
    return {
      status: runtime && runtime.state !== 'ready' ? 'unavailable' : 'ok',
      ...(runtime ? { runtime } : {}),
      ...(options.activity ? { activityLog: options.activity.health() } : {}),
    };
  });

  if (options.pacing) {
    const pacing = options.pacing;
    app.get('/api/youtube/pacing', async () => pacing.status());
  }

  if (options.agentInfo && options.agentToken === undefined) {
    app.get('/api/agent/connection', async () => options.agentInfo);
  }

  app.get<{ Querystring: Record<string, unknown> }>('/api/documents', async (request) => {
    const query = singleValues(request.query);
    return options.collector!.listDocuments(documentFilter(query), pagination(query));
  });

  app.get('/api/documents/sources', async () => ({
    sources: await options.collector!.sources({
      youtube: await options.channels?.listChannels() ?? [],
      removedYoutube: await options.channels?.listRemovals?.() ?? [],
    }),
  }));

  app.get<{ Querystring: Record<string, unknown> }>('/api/search', async (request) => {
    if (!options.search) {
      throw new CollectorError('search_unavailable', '搜尋服務尚未啟用。');
    }
    const parameters = singleValues(request.query);
    const query = parameters.q?.trim() ?? '';
    const { publishedFrom, publishedTo } = parameters;
    if (query.length > 500) {
      throw new CollectorError('invalid_request', '搜尋條件過長。');
    }
    if (
      (publishedFrom && !isCalendarDate(publishedFrom))
      || (publishedTo && !isCalendarDate(publishedTo))
      || (publishedFrom && publishedTo && publishedFrom > publishedTo)
    ) {
      throw new CollectorError('invalid_request', '發布日期篩選無效。');
    }
    const page = pagination(parameters);
    if (page.offset % page.limit !== 0) {
      throw new CollectorError('invalid_request', '搜尋的 offset 必須是 limit 的整數倍。');
    }
    return options.search.search({
      query,
      ...documentFilter(parameters),
      ...(publishedFrom ? { publishedFrom } : {}),
      ...(publishedTo ? { publishedTo } : {}),
      ...page,
    });
  });

  const searchStatus = async (): Promise<SearchStatusReport> => ({
    ...(options.search?.status() ?? {
      state: 'error',
      indexedDocuments: 0,
      lastRebuiltAt: null,
      message: '搜尋服務尚未啟用。',
    }),
    vaultDocuments: (await options.collector?.list())?.length ?? 0,
  });

  app.get('/api/search/status', async () => ({ status: await searchStatus() }));

  app.post('/api/search/rebuild', async () => {
    if (!options.search) {
      throw new CollectorError('search_unavailable', '搜尋服務尚未啟用。');
    }
    await options.search.rebuild();
    return { status: await searchStatus() };
  });

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (request) => ({
    document: await options.collector!.read(request.params.id),
  }));

  app.delete<{ Params: { id: string } }>('/api/documents/:id', async (request) =>
    options.collector!.delete(request.params.id));

  if (options.jobs) {
    const jobs = options.jobs;
    app.post<{ Body: { url?: unknown } }>('/api/youtube/submissions', async (request, reply) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請輸入 YouTube 影片網址、頻道網址或 @handle。');
      }
      return reply.code(202).send(await jobs.submit(request.body.url));
    });

    app.post<{ Body: { url?: unknown } }>('/api/youtube/collect', async (request, reply) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請輸入 YouTube 影片網址。');
      }
      return reply.code(202).send(await jobs.submitVideo(request.body.url));
    });

    app.get<{ Querystring: { state?: string; limit?: string; cursor?: string } }>('/api/jobs', async (request) => {
      const { state, cursor } = request.query;
      if (state !== undefined && state !== 'active' && state !== 'all') {
        throw new CollectorError('invalid_request', 'state 只能是 active 或 all。');
      }
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 100)) {
        throw new CollectorError('invalid_request', '分頁位置無效。');
      }
      const { limit } = pagination({ limit: request.query.limit ?? '20' });
      return jobs.list({ ...(state ? { state } : {}), limit, ...(cursor ? { cursor } : {}) });
    });

    app.get<{ Querystring: Record<string, unknown> }>('/api/jobs/summary', async (request) => {
      const { since } = singleValues(request.query);
      if (since !== undefined && !isInstant(since)) throw new CollectorError('invalid_request', 'since 必須是 ISO 時間。');
      return { summary: jobs.summary(since ?? new Date(Date.now() - 86_400_000).toISOString()) };
    });

    app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) => ({
      job: jobs.get(request.params.id),
    }));

    app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) =>
      reply.code(202).send(await jobs.retry(request.params.id)));
  }

  if (options.activity) {
    const activity = options.activity;
    app.get<{ Querystring: Record<string, unknown> }>('/api/activity', async (request) => ({
      ...(await activity.query(activityQuery(singleValues(request.query)))),
    }));
  }

  if (options.schedule) {
    const schedule = options.schedule;
    app.get('/api/youtube/schedule', async () => ({
      schedule: await schedule.getSchedule(),
    }));

    app.put<{ Body: Record<string, unknown> | null }>('/api/youtube/schedule', async (request) => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new CollectorError('invalid_request', '自動檢查設定必須是 JSON 物件。');
      }
      const keys = Object.keys(body);
      const unknown = keys.find((key) => !SCHEDULE_FIELDS.has(key));
      if (unknown) throw new CollectorError('invalid_request', `不支援的設定欄位：${unknown}`);
      if (typeof body.enabled !== 'boolean') throw new CollectorError('invalid_request', '自動檢查開關必須是 true 或 false。');
      return { schedule: await schedule.updateSchedule({ enabled: body.enabled }) };
    });
  }

  if (options.channels) {
    const channels = options.channels;
    app.get('/api/youtube/channels', async () => ({
      channels: await channels.listSubscriptions(),
    }));

    app.post<{ Body: { url?: unknown } }>('/api/youtube/channel-previews', async (request) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請輸入 YouTube 頻道網址或 @handle。');
      }
      return { preview: await channels.preview(request.body.url) };
    });

    app.post<{ Body: { url?: unknown; settings?: unknown } }>('/api/youtube/channels', async (request, reply) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請輸入 YouTube 頻道網址或 @handle。');
      }
      const settings = request.body.settings === undefined ? {} : parsePolicyPatch(request.body.settings, { allowEmpty: true });
      return reply.code(202).send(await channels.addChannel(request.body.url, settings));
    });

    // Settings change first, so the check a resume in the same request starts uses the new range.
    app.patch<{
      Params: { id: string };
      Body: { enabled?: unknown; settings?: unknown } | null;
    }>('/api/youtube/channels/:id', async (request) => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CollectorError('invalid_request', '頻道設定必須是 JSON 物件。');
      const unknown = Object.keys(body).find((key) => key !== 'enabled' && key !== 'settings');
      if (unknown) throw new CollectorError('invalid_request', `不支援的欄位：${unknown}`);
      if (body.enabled === undefined && body.settings === undefined) throw new CollectorError('invalid_request', '請提供 enabled 或 settings。');
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new CollectorError('invalid_request', '頻道啟用設定無效。');
      const settings = body.settings === undefined ? null : parsePolicyPatch(body.settings);
      let channel = settings ? await channels.updateSettings(request.params.id, settings) : null;
      let submission: JobSubmission | null = null;
      if (typeof body.enabled === 'boolean') ({ channel, submission } = await channels.setChannelEnabled(request.params.id, body.enabled));
      return { channel, submission };
    });

    app.post<{ Params: { id: string } }>('/api/youtube/channels/:id/apply-settings', async (request) =>
      channels.applySettingsToAll(request.params.id));

    // `documents=keep` (the default) leaves the channel's documents; `documents=delete` deletes them.
    app.delete<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/api/youtube/channels/:id', async (request) => {
      const { documents = 'keep' } = singleValues(request.query);
      if (documents !== 'keep' && documents !== 'delete') throw new CollectorError('invalid_request', 'documents 只接受 keep 或 delete。');
      const { documentsKept, documentsDeleted, documentsFailed } = await channels.removeChannel(request.params.id, { documents });
      return { removed: true, documentsKept, documentsDeleted, documentsFailed };
    });

    app.post<{ Body?: { channelIds?: unknown } }>('/api/youtube/channel-runs', async (request, reply) => {
      const channelIds = request.body?.channelIds;
      if (
        channelIds !== undefined
        && (!Array.isArray(channelIds)
          || channelIds.length === 0
          || !channelIds.every((id) => typeof id === 'string' && id.length > 0))
      ) {
        throw new CollectorError('invalid_request', '頻道執行範圍無效。');
      }
      // Checking every subscription goes through the scheduler, which refuses while the Vault is moving.
      const submissions = channelIds === undefined && options.schedule
        ? await options.schedule.runNow()
        : await channels.startRun({ trigger: 'manual', ...(channelIds ? { channelIds: channelIds as string[] } : {}) });
      return reply.code(202).send({ submissions });
    });
  }

  const sourceTypes = options.sourceTypes ?? SOURCE_TYPES;
  app.get('/api/source-types', async () => ({ sourceTypes: sourceTypes.map(sourceTypeInfo) }));

  if (options.channels) {
    const channels = options.channels;
    const catalog = new SourceCatalog(sourceTypes, channels, async () => await options.collector?.list() ?? []);

    // Every address answers 200 with a status; only a missing address is a malformed request.
    app.post<{ Body: { url?: unknown } }>('/api/url-recognitions', async (request) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請貼上要加入的網址。');
      }
      return { recognition: await recognizeUrl(request.body.url, sourceTypes, { previewChannel: (url) => channels.preview(url) }) };
    });

    app.get('/api/sources', async () => catalog.list());

    app.get<{ Params: { type: string; id: string } }>('/api/sources/:type/:id', async (request) =>
      catalog.detail(request.params.type, request.params.id));
  }

  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, {
      root: path.resolve(options.webRoot),
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        void reply.status(404).send({
          error: { code: 'not_found', message: '找不到這個 API。' },
        });
        return;
      }
      void reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}

const SEVERITIES: ReadonlySet<string> = new Set<EventSeverity>(['info', 'warning', 'error']);
const ACTIVITY_PARAMETERS = new Set(['severity', 'eventType', 'jobId', 'subscriptionId', 'since', 'until', 'limit', 'cursor']);

function activityQuery(query: Record<string, string | undefined>): ActivityQuery {
  const unknown = Object.keys(query).find((key) => !ACTIVITY_PARAMETERS.has(key));
  if (unknown) throw new CollectorError('invalid_request', `不支援的查詢參數：${unknown}`);
  const list = (value: string | undefined) => value?.split(',').map((item) => item.trim()).filter(Boolean);
  const severity = list(query.severity);
  if (severity && (severity.length === 0 || !severity.every((value) => SEVERITIES.has(value)))) {
    throw new CollectorError('invalid_request', 'severity 只能是 info、warning、error，以逗號分隔。');
  }
  const eventType = list(query.eventType);
  if (eventType && (eventType.length === 0 || !eventType.every((value) => /^[a-z_.]{1,60}$/u.test(value)))) {
    throw new CollectorError('invalid_request', 'eventType 格式無效。');
  }
  for (const key of ['jobId', 'subscriptionId'] as const) {
    const value = query[key];
    if (value !== undefined && (value === '' || value.length > 200)) throw new CollectorError('invalid_request', `${key} 長度須在 1 到 200 之間。`);
  }
  for (const key of ['since', 'until'] as const) {
    const value = query[key];
    if (value !== undefined && !isInstant(value)) throw new CollectorError('invalid_request', `${key} 必須是 ISO 時間。`);
  }
  if (query.cursor !== undefined && (query.cursor === '' || query.cursor.length > 500)) {
    throw new CollectorError('invalid_request', '分頁位置無效。');
  }
  const { limit } = pagination({ limit: query.limit ?? '50' });
  return {
    ...(severity ? { severity: severity as EventSeverity[] } : {}),
    ...(eventType ? { eventType } : {}),
    ...(query.jobId ? { jobId: query.jobId } : {}),
    ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
    ...(query.since ? { since: query.since } : {}),
    ...(query.until ? { until: query.until } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit,
  };
}

/** An ISO date-time with an explicit offset or Z, so the instant does not depend on the server's time zone. */
function isInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && !Number.isNaN(Date.parse(value));
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Rejects repeated query parameters so each filter has exactly one value. */
function singleValues(query: Record<string, unknown>): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') {
      throw new CollectorError('invalid_request', '每個查詢參數只能提供一個值。');
    }
    values[key] = value;
  }
  return values;
}

/** Source filters use stable IDs; publisher names are display text and never filter. */
function documentFilter(query: Record<string, string | undefined>): DocumentFilter {
  if (query.channel !== undefined) {
    throw new CollectorError('invalid_request', '不支援以頻道名稱篩選，請改用 sourceType 與 publisherId。');
  }
  const { sourceType, publisherId } = query;
  if (sourceType !== undefined && !DOCUMENT_SOURCE_TYPES.includes(sourceType as DocumentSourceType)) {
    throw new CollectorError('invalid_request', '不支援的 sourceType。');
  }
  if (publisherId !== undefined && (sourceType === undefined || publisherId === '' || publisherId.length > 200)) {
    throw new CollectorError('invalid_request', 'publisherId 需要搭配 sourceType，且長度須在 1 到 200 之間。');
  }
  return {
    ...(sourceType ? { sourceType: sourceType as DocumentSourceType } : {}),
    ...(publisherId ? { publisherId } : {}),
  };
}

function pagination(query: { offset?: string | undefined; limit?: string | undefined }): { offset: number; limit: number } {
  const parse = (value: string | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
      throw new CollectorError('invalid_request', '分頁參數必須是整數。');
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new CollectorError('invalid_request', 'offset 必須介於 0 到 1000000，limit 必須介於 1 到 100。');
    }
    return number;
  };
  return { offset: parse(query.offset, 0, 0, 1_000_000), limit: parse(query.limit, 50, 1, 100) };
}

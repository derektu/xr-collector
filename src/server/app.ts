import type { VaultWorkspace } from '../vault/workspace.js';
import type { Pacing } from '../pacing/pacing-gate.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Collector } from '../core/collector.js';
import type { CollectorRuntimeStatus } from '../runtime/collector-runtime.js';
import { sourceDeclaration, sourceDeclarations, sourceDefinitions, subscriptionKindLabel } from '../core/source-registry.js';
import type { SubscriptionDeclaration } from '../plugins/types.js';
import { SourceCatalog } from '../sources/source-catalog.js';
import { addressOwner, recognizeUrl, sourceTypeDeclarations, sourceTypeInfo, type SourceTypeDeclaration } from '../sources/source-types.js';
import {
  CollectorError,
  type CoreErrorCode,
  type ActivityLogHealth,
  type ActivityPage,
  type ActivityQuery,
  type EventSeverity,
  type JobSummary,
  type CollectionJob,
  type JobPage,
  type JobSubmission,
  type JobSubmissionView,
  type JobView,
  type CollectionSchedule,
  type DocumentFilter,
  type SearchStatusReport,
  type TranscriptSearch,
  type VaultInspection,
  type VaultSetupAction,
  type VaultSetupResult,
  type VaultSetupStatus,
  type PendingSubscription,
  type Subscription,
  type SubscriptionPreview,
  type SubscriptionRecord,
  type SubscriptionSettings,
} from '../core/types.js';

/** The subscriptions of one source type, as the HTTP API manages them. */
export interface SubscriptionCollection {
  readonly type: string;
  list(): Promise<SubscriptionRecord[]>;
  listSubscriptions(): Promise<Subscription[]>;
  preview(url: string): Promise<SubscriptionPreview>;
  add(url: string, settings?: Partial<SubscriptionSettings>): Promise<JobSubmission>;
  setEnabled(id: string, enabled: boolean): Promise<{ subscription: SubscriptionRecord; submission: JobSubmission | null }>;
  updateSettings(id: string, patch: Partial<SubscriptionSettings>): Promise<SubscriptionRecord>;
  applySettingsToAll(id: string): Promise<{ updated: number; paused: number }>;
  remove(id: string, options?: { documents?: 'keep' | 'delete' }): Promise<{ documentsKept: number; documentsDeleted: number; documentsFailed: number }>;
  /** Subscription requests still resolving their address. */
  pendingSubscriptions?(): Promise<PendingSubscription[]>;
  /** Subscriptions removed and not added again. */
  listRemovals?(): Promise<Array<{ id: string; title: string }>>;
  startRun(request: { trigger: 'manual'; subscriptionIds?: string[] }): Promise<JobSubmission[]>;
  checkJobs(id: string): CollectionJob[];
}

/** Accepts collection work and answers job queries for the active Vault. */
export interface CollectionJobs {
  submit(type: string, url: string): Promise<JobSubmission>;
  submitItem(type: string, url: string): Promise<JobSubmission>;
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

export interface ScheduleManagement {
  getSchedule(): Promise<CollectionSchedule>;
  updateSchedule(input: { enabled: boolean }): Promise<CollectionSchedule>;
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
  '/api/health', '/api/agent/connection', '/api/vault/setup', '/api/vault/inspect', '/api/activity', '/api/pacing',
]);

export interface HttpAppOptions {
  collector?: Collector;
  jobs?: CollectionJobs;
  activity?: ActivityAccess;
  transfer?: VaultWorkspace;
  /** The subscriptions of each source type with subscriptions. */
  subscriptions?: readonly SubscriptionCollection[];
  schedule?: ScheduleManagement;
  search?: TranscriptSearch;
  /** The device's request channels, one per pacing group; readable whatever state the Vault is in. */
  pacing?: readonly Pacing[];
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

const appDrains = new WeakMap<FastifyInstance, () => Promise<void>>();

export function waitForHttpAppIdle(app: FastifyInstance): Promise<void> {
  return appDrains.get(app)?.() ?? Promise.resolve();
}

const ERROR_STATUS: Record<CoreErrorCode, number> = {
  vault_busy: 409,
  vault_not_ready: 503,
  vault_invalid: 422,
  vault_already_set: 409,
  invalid_url: 400,
  invalid_subscription: 400,
  invalid_request: 400,
  document_not_found: 404,
  document_deleted: 404,
  search_unavailable: 503,
  subscription_not_found: 404,
  subscription_paused: 409,
  out_of_range: 422,
  job_not_found: 404,
  job_not_retryable: 409,
  unsupported_url: 400,
  queue_full: 503,
  file_exists: 409,
  transfer_cancelled: 409,
  vault_location_fixed: 409,
  insufficient_space: 507,
  capture_failed: 502,
  network_error: 503,
  rate_limited: 503,
};

/** The HTTP status of an error code: the core's own, else the one a registered source type declares, else 500. */
export function errorStatus(code: string): number {
  const core = (ERROR_STATUS as Record<string, number>)[code];
  if (core !== undefined) return core;
  for (const definition of sourceDefinitions()) {
    const declared = definition.errorStatus?.[code];
    if (declared !== undefined) return declared;
  }
  return 500;
}

export async function createHttpApp(options: HttpAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  const subscriptions = options.subscriptions ?? [];
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
      void reply.status(errorStatus(error.code)).send({
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

  // Each pacing group is labelled with the name its source type declares for it.
  app.get('/api/pacing', async () => ({
    groups: (options.pacing ?? []).map((gate) => ({ group: gate.group, label: pacingLabel(gate.group), ...gate.status() })),
  }));

  if (options.agentInfo && options.agentToken === undefined) {
    app.get('/api/agent/connection', async () => options.agentInfo);
  }

  app.get<{ Querystring: Record<string, unknown> }>('/api/documents', async (request) => {
    const query = singleValues(request.query);
    return options.collector!.listDocuments(documentFilter(query), pagination(query));
  });

  app.get('/api/documents/sources', async () => {
    const byType: Record<string, { subscriptions: SubscriptionRecord[]; removals: Array<{ id: string; title: string }> }> = {};
    for (const collection of subscriptions) {
      byType[collection.type] = { subscriptions: await collection.list(), removals: await collection.listRemovals?.() ?? [] };
    }
    return { sources: await options.collector!.sources(byType) };
  });

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
    app.post<{ Body: { url?: unknown } }>('/api/submissions', async (request, reply) => {
      const { type, input } = ownedAddress(requiredUrl(request.body?.url, '請貼上要加入的網址。'));
      return reply.code(202).send(submissionView(await jobs.submit(type, input)));
    });

    app.post<{ Body: { url?: unknown } }>('/api/items', async (request, reply) => {
      const { type, input } = ownedAddress(requiredUrl(request.body?.url, '請貼上要收集的網址。'));
      return reply.code(202).send(submissionView(await jobs.submitItem(type, input)));
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
      const page = jobs.list({ ...(state ? { state } : {}), limit, ...(cursor ? { cursor } : {}) });
      return { jobs: page.jobs.map(jobView), nextCursor: page.nextCursor };
    });

    app.get<{ Querystring: Record<string, unknown> }>('/api/jobs/summary', async (request) => {
      const { since } = singleValues(request.query);
      if (since !== undefined && !isInstant(since)) throw new CollectorError('invalid_request', 'since 必須是 ISO 時間。');
      return { summary: jobs.summary(since ?? new Date(Date.now() - 86_400_000).toISOString()) };
    });

    app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) => ({
      job: jobView(jobs.get(request.params.id)),
    }));

    app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) =>
      reply.code(202).send(submissionView(await jobs.retry(request.params.id))));
  }

  if (options.activity) {
    const activity = options.activity;
    app.get<{ Querystring: Record<string, unknown> }>('/api/activity', async (request) => ({
      ...(await activity.query(activityQuery(singleValues(request.query)))),
    }));
  }

  if (options.schedule) {
    const schedule = options.schedule;
    // One switch covers the subscriptions of every source type.
    app.get('/api/schedule', async () => ({
      schedule: await schedule.getSchedule(),
    }));

    app.put<{ Body: Record<string, unknown> | null }>('/api/schedule', async (request) => {
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

  /** The subscriptions of a type, or `subscription_not_found` for a type without subscriptions. */
  const collectionOf = (type: string): { collection: SubscriptionCollection; subscription: SubscriptionDeclaration; targetNoun: string } => {
    const collection = subscriptions.find((candidate) => candidate.type === type);
    const subscription = sourceDeclaration(type)?.subscription;
    if (!collection || !subscription) throw new CollectorError('subscription_not_found', '找不到這個訂閱。');
    return { collection, subscription, targetNoun: subscription.targetNoun };
  };

  /** The type of a subscription address; an address of a type without subscriptions is not one. */
  const subscriptionAddress = (url: unknown): { type: string; input: string } & ReturnType<typeof collectionOf> => {
    const { type, input } = ownedAddress(requiredUrl(url, '請貼上要訂閱的網址。'));
    if (!subscriptions.some((candidate) => candidate.type === type)) {
      throw new CollectorError('invalid_subscription', '這個網址不能訂閱。');
    }
    return { type, input, ...collectionOf(type) };
  };

  if (subscriptions.length > 0) {
    app.post<{ Body: { url?: unknown } }>('/api/subscription-previews', async (request) => {
      const { collection, input } = subscriptionAddress(request.body?.url);
      return { preview: await collection.preview(input) };
    });

    app.post<{ Body: { url?: unknown; settings?: unknown } }>('/api/subscriptions', async (request, reply) => {
      const { collection, subscription, input } = subscriptionAddress(request.body?.url);
      const settings = request.body.settings === undefined ? {} : subscription.parseSettingsPatch(request.body.settings, { allowEmpty: true });
      return reply.code(202).send(submissionView(await collection.add(input, settings)));
    });

    // Settings change first, so the check a resume in the same request starts uses the new range.
    app.patch<{
      Params: { type: string; id: string };
      Body: { enabled?: unknown; settings?: unknown } | null;
    }>('/api/subscriptions/:type/:id', async (request) => {
      const { collection, subscription, targetNoun } = collectionOf(request.params.type);
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CollectorError('invalid_request', `${targetNoun}設定必須是 JSON 物件。`);
      const unknown = Object.keys(body).find((key) => key !== 'enabled' && key !== 'settings');
      if (unknown) throw new CollectorError('invalid_request', `不支援的欄位：${unknown}`);
      if (body.enabled === undefined && body.settings === undefined) throw new CollectorError('invalid_request', '請提供 enabled 或 settings。');
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new CollectorError('invalid_request', `${targetNoun}啟用設定無效。`);
      const settings = body.settings === undefined ? null : subscription.parseSettingsPatch(body.settings);
      let record = settings ? await collection.updateSettings(request.params.id, settings) : null;
      let submission: JobSubmission | null = null;
      if (typeof body.enabled === 'boolean') ({ subscription: record, submission } = await collection.setEnabled(request.params.id, body.enabled));
      return { subscription: record, submission: submission ? submissionView(submission) : null };
    });

    app.post<{ Params: { type: string; id: string } }>('/api/subscriptions/:type/:id/apply-settings', async (request) =>
      collectionOf(request.params.type).collection.applySettingsToAll(request.params.id));

    // `documents=keep` (the default) leaves the subscription's documents; `documents=delete` deletes them.
    app.delete<{ Params: { type: string; id: string }; Querystring: Record<string, unknown> }>('/api/subscriptions/:type/:id', async (request) => {
      const { collection } = collectionOf(request.params.type);
      const { documents = 'keep' } = singleValues(request.query);
      if (documents !== 'keep' && documents !== 'delete') throw new CollectorError('invalid_request', 'documents 只接受 keep 或 delete。');
      const { documentsKept, documentsDeleted, documentsFailed } = await collection.remove(request.params.id, { documents });
      return { removed: true, documentsKept, documentsDeleted, documentsFailed };
    });

    app.post<{ Body?: { subscriptions?: unknown } | null }>('/api/subscription-checks', async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) throw new CollectorError('invalid_request', '檢查範圍必須是 JSON 物件。');
      const unknown = Object.keys(body).find((key) => key !== 'subscriptions');
      if (unknown) throw new CollectorError('invalid_request', `不支援的欄位：${unknown}`);
      const listed = body.subscriptions;
      if (listed === undefined) {
        // Checking every subscription goes through the scheduler, which refuses while the Vault is moving.
        const submissions = options.schedule ? await options.schedule.runNow() : await checkEveryEnabled(subscriptions);
        return reply.code(202).send({ submissions: submissions.map(submissionView) });
      }
      if (!Array.isArray(listed) || listed.length === 0 || !listed.every(isSubscriptionKey)) {
        throw new CollectorError('invalid_request', 'subscriptions 必須是非空的 {type, id} 清單。');
      }
      const byType = new Map<string, string[]>();
      for (const { type, id } of listed) byType.set(type, [...byType.get(type) ?? [], id]);
      // Every listed subscription is checked before any job starts, so a refused request starts nothing.
      const runs = await Promise.all([...byType].map(async ([type, ids]) => {
        const { collection } = collectionOf(type);
        const records = await collection.list();
        for (const id of ids) {
          const record = records.find((candidate) => candidate.id === id);
          if (!record) throw new CollectorError('subscription_not_found', `找不到這個 ${subscriptionKindLabel(type)}訂閱。`);
          if (!record.enabled) throw new CollectorError('subscription_paused', `「${record.title}」已暫停，請先恢復訂閱。`);
        }
        return { collection, ids };
      }));
      const submissions: JobSubmission[] = [];
      for (const { collection, ids } of runs) submissions.push(...await collection.startRun({ trigger: 'manual', subscriptionIds: ids }));
      return reply.code(202).send({ submissions: submissions.map(submissionView) });
    });
  }

  const sourceTypes = options.sourceTypes ?? sourceTypeDeclarations();
  app.get('/api/source-types', async () => ({ sourceTypes: sourceTypes.map(sourceTypeInfo) }));

  if (subscriptions.length > 0) {
    const catalog = new SourceCatalog(sourceTypes, subscriptions, async () => await options.collector?.list() ?? []);
    const previewSubscription = (type: string, url: string): Promise<SubscriptionPreview> => collectionOf(type).collection.preview(url);

    // Every address answers 200 with a status; only a missing address is a malformed request.
    app.post<{ Body: { url?: unknown } }>('/api/url-recognitions', async (request) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請貼上要加入的網址。');
      }
      return { recognition: await recognizeUrl(request.body.url, sourceTypes, { previewSubscription }) };
    });

    app.get<{ Querystring: Record<string, unknown> }>('/api/subscriptions', async (request) => {
      const query = singleValues(request.query);
      const unknown = Object.keys(query).find((key) => key !== 'type');
      if (unknown) throw new CollectorError('invalid_request', `不支援的查詢參數：${unknown}`);
      if (query.type !== undefined && !subscriptions.some((collection) => collection.type === query.type)) {
        throw new CollectorError('invalid_request', '不支援的 type。');
      }
      return catalog.list(query.type);
    });

    app.get<{ Params: { type: string; id: string } }>('/api/subscriptions/:type/:id', async (request) =>
      catalog.detail(request.params.type, request.params.id));
  }

  const webRoot = options.webRoot && existsSync(options.webRoot) ? options.webRoot : null;
  if (webRoot) {
    await app.register(fastifyStatic, {
      root: path.resolve(webRoot),
      prefix: '/',
      wildcard: false,
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (webRoot && !request.url.startsWith('/api/')) {
      void reply.type('text/html').sendFile('index.html');
      return;
    }
    void reply.status(404).send({
      error: { code: 'not_found', message: '找不到這個 API。' },
    });
  });

  return app;
}

/** A job as the HTTP API returns it: restart data left out, and an add job's subscription named `subscriptionId`. */
function jobView(job: CollectionJob): JobView {
  const { checkpoint: _checkpoint, claimedByUser: _claimed, result, ...rest } = job;
  if (!result) return { ...rest, result: null };
  const { channelId, ...outcome } = result;
  return { ...rest, result: channelId === undefined ? outcome : { ...outcome, subscriptionId: channelId } };
}

function submissionView(submission: JobSubmission): JobSubmissionView {
  return { job: jobView(submission.job), deduplicated: submission.deduplicated };
}

function requiredUrl(value: unknown, prompt: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CollectorError('invalid_request', prompt);
  return value;
}

/**
 * The registered source type that owns an address, with the address as that type reads it. An
 * address no type owns is `unsupported_url`, or `invalid_url` when it is not an address at all.
 */
function ownedAddress(value: string): { type: string; input: string } {
  const { input, url, owner } = addressOwner(value, sourceDeclarations());
  if (!owner) {
    throw url
      ? new CollectorError('unsupported_url', '目前還不支援這個網站的網址。')
      : new CollectorError('invalid_url', '請貼上完整網址，例如 https:// 開頭的網址。');
  }
  return { type: owner.id, input };
}

function isSubscriptionKey(value: unknown): value is { type: string; id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { type, id } = value as Record<string, unknown>;
  return Object.keys(value).every((key) => key === 'type' || key === 'id')
    && typeof type === 'string' && type.length > 0 && typeof id === 'string' && id.length > 0;
}

/** Checks the enabled subscriptions of every type; used when no scheduler serves the request. */
async function checkEveryEnabled(collections: readonly SubscriptionCollection[]): Promise<JobSubmission[]> {
  const submissions: JobSubmission[] = [];
  for (const collection of collections) {
    if ((await collection.list()).some((record) => record.enabled)) submissions.push(...await collection.startRun({ trigger: 'manual' }));
  }
  if (submissions.length === 0) throw new CollectorError('invalid_request', '沒有可檢查的訂閱。');
  return submissions;
}

/** The label a source type gives its pacing group; the group ID when no registered type declares it. */
function pacingLabel(group: string): string {
  return sourceDefinitions().find((definition) => definition.pacing?.group === group)?.pacing?.label ?? group;
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
  if (sourceType !== undefined && !sourceDeclaration(sourceType)) {
    throw new CollectorError('invalid_request', '不支援的 sourceType。');
  }
  if (publisherId !== undefined && (sourceType === undefined || publisherId === '' || publisherId.length > 200)) {
    throw new CollectorError('invalid_request', 'publisherId 需要搭配 sourceType，且長度須在 1 到 200 之間。');
  }
  return {
    ...(sourceType ? { sourceType } : {}),
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

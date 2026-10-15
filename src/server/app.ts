import type { VaultWorkspace } from '../vault/workspace.js';
import { PACKAGE_LIMIT } from '../vault/vault-package.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Collector } from '../core/collector.js';
import type { CollectorRuntimeStatus } from '../runtime/collector-runtime.js';
import {
  CollectorError,
  type CollectionJob,
  type JobPage,
  type JobSubmission,
  type MergeChoice,
  type ChannelSchedule,
  type TranscriptSearch,
  type VaultInspection,
  type VaultSetupAction,
  type VaultSetupResult,
  type VaultSetupStatus,
  type YouTubeChannel,
} from '../core/types.js';

export interface ChannelCollection {
  listChannels(): Promise<YouTubeChannel[]>;
  addChannel(url: string): Promise<JobSubmission>;
  setChannelEnabled(id: string, enabled: boolean): Promise<YouTubeChannel>;
  removeChannel(id: string): Promise<void>;
  startRun(channelIds?: string[]): Promise<JobSubmission[]>;
}

/** Accepts collection work and answers job queries for the active Vault. */
export interface CollectionJobs {
  submit(url: string): Promise<JobSubmission>;
  submitVideo(url: string): Promise<JobSubmission>;
  get(id: string): CollectionJob;
  list(query: { state?: 'active' | 'all'; limit?: number; cursor?: string }): JobPage;
}

export interface ChannelScheduleManagement {
  getSchedule(): Promise<ChannelSchedule>;
  updateSchedule(input: { enabled: boolean; intervalMinutes: number }): Promise<ChannelSchedule>;
}

/** Vault location operations that stay available before a Vault is active. */
export interface VaultSetup {
  status(): VaultSetupStatus;
  inspect(path: string): Promise<VaultInspection>;
  setup(action: VaultSetupAction, path: string): Promise<VaultSetupResult>;
}

/** Routes a not-ready runtime still serves so UI and Agents can finish setup. */
const NOT_READY_ROUTES = new Set(['/api/health', '/api/agent/connection', '/api/vault/setup', '/api/vault/inspect']);

export interface HttpAppOptions {
  collector?: Collector;
  jobs?: CollectionJobs;
  transfer?: VaultWorkspace;
  channels?: ChannelCollection;
  schedule?: ChannelScheduleManagement;
  search?: TranscriptSearch;
  webRoot?: string;
  agentToken?: string;
  agentInfo?: { connectionFile: string; skillPath: string; url: string };
  runtimeStatus?: () => CollectorRuntimeStatus;
  /** Returns why business routes are unavailable, or null once a Vault is active. */
  notReady?: () => string | null;
  vaultSetup?: VaultSetup;
}

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
  search_unavailable: 503,
  channel_not_found: 404,
  job_not_found: 404,
  unsupported_url: 400,
  queue_full: 503,
  no_subtitles: 422,
  video_unavailable: 422,
  capture_failed: 502,
  network_error: 503,
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
    app.post<{ Body: { action?: unknown; path?: unknown } }>('/api/vault/setup', async (request) => {
      const { action, path: vaultPath } = request.body ?? {};
      if ((action !== 'create' && action !== 'open') || typeof vaultPath !== 'string' || vaultPath.trim() === '') {
        throw new CollectorError('invalid_request', '請提供 action（create 或 open）與知識庫目錄路徑。');
      }
      return vaultSetup.setup(action, vaultPath);
    });
  }

  if (options.transfer) {
    const transfer = options.transfer;
    const writes = new WeakMap<object, () => void>();
    app.addHook('preHandler', async (request) => {
      if (['GET', 'HEAD'].includes(request.method) && request.url.startsWith('/api/')
        && request.routeOptions.url !== '/api/vault/status'
        // Job state is device data and stays readable while a merge holds the Vault.
        && !request.routeOptions.url?.startsWith('/api/jobs')
        && !NOT_READY_ROUTES.has(request.routeOptions.url ?? '')) transfer.assertReadable();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)
        && !request.routeOptions.url?.startsWith('/api/vault/')) {
        writes.set(request, transfer.enterWrite());
      }
    });
    app.addHook('onResponse', async (request) => { writes.get(request)?.(); });
    app.addHook('onSend', async (request, _reply, payload) => { writes.get(request)?.(); return payload; });
    app.addHook('onError', async (request) => { writes.get(request)?.(); });
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: PACKAGE_LIMIT }, (_request, body, done) => done(null, body));
    app.get('/api/vault/status', async () => transfer.status());
    app.post('/api/vault/export', async (_request, reply) => {
      const buffer = await transfer.export();
      return reply.type('application/octet-stream')
        .header('Content-Disposition', 'attachment; filename="xr-collector.xr-vault"').send(buffer);
    });
    app.post<{ Body: Buffer }>('/api/vault/merge/preview', { bodyLimit: PACKAGE_LIMIT }, async (request) => {
      if (!Buffer.isBuffer(request.body)) throw new CollectorError('invalid_request', '請上傳 .xr-vault 資料包。');
      return transfer.previewMerge(request.body);
    });
    app.post<{ Body: { id: string; choices: Record<string, MergeChoice> } }>('/api/vault/merge/apply', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
      return reply.code(202).send(transfer.applyMerge(request.body?.id, request.body?.choices));
    });
    app.post<{ Body: { id: string } }>('/api/vault/merge/cancel', async (request) => {
      transfer.cancelMerge(request.body?.id);
      return { cancelled: true };
    });
    app.post<{ Body: Buffer }>('/api/vault/restore', { bodyLimit: PACKAGE_LIMIT }, async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw new CollectorError('invalid_request', '請上傳 .xr-vault 資料包。');
      const status = transfer.restore(request.body);
      return reply.code(202).send(status);
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
      void reply.status(ERROR_STATUS[error.code]).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) {
      void reply.status(413).send({ error: { code: 'invalid_request', message: '資料包超過 128 MiB。' } });
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
    };
  });

  if (options.agentInfo && options.agentToken === undefined) {
    app.get('/api/agent/connection', async () => options.agentInfo);
  }

  app.get<{ Querystring: { offset?: string; limit?: string } }>('/api/documents', async (request) => {
    const documents = await options.collector!.list();
    documents.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || a.id.localeCompare(b.id));
    if (options.agentToken === undefined && request.query.offset === undefined && request.query.limit === undefined) {
      return { documents };
    }
    const { offset, limit } = pagination(request.query);
    return {
      documents: documents.slice(offset, offset + limit),
      total: documents.length,
      offset,
      limit,
      nextOffset: offset + limit < documents.length ? offset + limit : null,
    };
  });

  app.get<{
    Querystring: {
      q?: string;
      channel?: string;
      publishedFrom?: string;
      publishedTo?: string;
      offset?: string;
      limit?: string;
    };
  }>('/api/search', async (request) => {
    if (!options.search) {
      throw new CollectorError('search_unavailable', '搜尋服務尚未啟用。');
    }
    for (const value of Object.values(request.query)) {
      if (typeof value !== 'string') {
        throw new CollectorError('invalid_request', '每個搜尋參數只能提供一個值。');
      }
    }
    const query = request.query.q?.trim() ?? '';
    const { channel, publishedFrom, publishedTo } = request.query;
    if (query.length > 500 || (channel?.length ?? 0) > 200) {
      throw new CollectorError('invalid_request', '搜尋條件過長。');
    }
    if (
      (publishedFrom && !isCalendarDate(publishedFrom))
      || (publishedTo && !isCalendarDate(publishedTo))
      || (publishedFrom && publishedTo && publishedFrom > publishedTo)
    ) {
      throw new CollectorError('invalid_request', '發布日期篩選無效。');
    }
    return options.search.search({
      query,
      ...(channel ? { channel } : {}),
      ...(publishedFrom ? { publishedFrom } : {}),
      ...(publishedTo ? { publishedTo } : {}),
      ...((request.query.offset !== undefined || request.query.limit !== undefined)
        ? pagination(request.query) : {}),
    });
  });

  app.get('/api/search/status', async () => ({
    status: options.search?.status() ?? {
      state: 'error',
      indexedDocuments: 0,
      message: '搜尋服務尚未啟用。',
    },
  }));

  app.post('/api/search/rebuild', async () => {
    if (!options.search) {
      throw new CollectorError('search_unavailable', '搜尋服務尚未啟用。');
    }
    await options.search.rebuild();
    return { status: options.search.status() };
  });

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (request) => ({
    document: await options.collector!.read(request.params.id),
  }));

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

    app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) => ({
      job: jobs.get(request.params.id),
    }));
  }

  if (options.schedule) {
    const schedule = options.schedule;
    app.get('/api/youtube/schedule', async () => ({
      schedule: await schedule.getSchedule(),
    }));

    app.put<{
      Body: { enabled?: unknown; intervalMinutes?: unknown };
    }>('/api/youtube/schedule', async (request) => {
      const { enabled, intervalMinutes } = request.body ?? {};
      if (
        typeof enabled !== 'boolean'
        || !Number.isInteger(intervalMinutes)
        || (intervalMinutes as number) < 1
        || (intervalMinutes as number) > 10_080
      ) {
        throw new CollectorError('invalid_request', '排程設定無效。');
      }
      return {
        schedule: await schedule.updateSchedule({
          enabled,
          intervalMinutes: intervalMinutes as number,
        }),
      };
    });
  }

  if (options.channels) {
    const channels = options.channels;
    app.get('/api/youtube/channels', async () => ({
      channels: await channels.listChannels(),
    }));

    app.post<{ Body: { url?: unknown } }>('/api/youtube/channels', async (request, reply) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請輸入 YouTube 頻道網址或 @handle。');
      }
      return reply.code(202).send(await channels.addChannel(request.body.url));
    });

    app.patch<{
      Params: { id: string };
      Body: { enabled?: unknown };
    }>('/api/youtube/channels/:id', async (request) => {
      if (typeof request.body?.enabled !== 'boolean') {
        throw new CollectorError('invalid_request', '頻道啟用設定無效。');
      }
      return {
        channel: await channels.setChannelEnabled(request.params.id, request.body.enabled),
      };
    });

    app.delete<{ Params: { id: string } }>('/api/youtube/channels/:id', async (request) => {
      await channels.removeChannel(request.params.id);
      return { removed: true };
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
      const submissions = await channels.startRun(channelIds as string[] | undefined);
      return reply.code(202).send({ submissions });
    });
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

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function pagination(query: { offset?: string; limit?: string }): { offset: number; limit: number } {
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

import type { ChangeFeed, AgentConnectionAccess } from '../../app/runtime/index.js';
import type { Collector, VaultOperations } from '../../domain/vault/index.js';
import type { Pacing } from '../../domain/pacing/index.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { maskSecrets, maskSecretsJson, redact } from '../../shared/lib/redact.js';
import type { LoginStartupAccess } from '../../shared/api/login-startup.js';
import { loadBuildInfo, type UpdateAccess } from '../../domain/updates/index.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import { sourceTypeDeclarations, type SourceTypeDeclaration } from '../../domain/sources/index.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { CollectorRuntimeStatus, NotificationAccess } from '../../shared/api/device-types.js';
import type { ActivityAccess } from '../../shared/activity/activity-types.js';
import type { VaultSetup } from '../../shared/vault/vault-types.js';
import type { BuildInfo } from '../../shared/api/update-types.js';
import type { TranscriptSearch } from '../../shared/api/search-types.js';
import { errorStatus, requestErrorMessage, requestErrorStatus } from './error-status.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerChangeRoutes } from './routes/changes.js';
import { registerDeviceRoutes } from './routes/device.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerJobRoutes, type CollectionJobs } from './routes/jobs.js';
import { networkGuard, type ConnectivityAccess } from './routes/network.js';
import { registerScheduleRoutes, type ScheduleManagement } from './routes/schedule.js';
import { registerSubscriptionRoutes, type SubscriptionCollection } from './routes/subscriptions.js';
import { registerVaultSetupRoutes } from './routes/vault-setup.js';
import { registerVaultTransferRoutes } from './routes/vault-transfer.js';

export type {
  ActivityAccess, CollectionJobs, ConnectivityAccess, NotificationAccess, ScheduleManagement, SubscriptionCollection, VaultSetup,
};

export interface HttpAppOptions {
  sources: SourceRegistry;
  buildInfo?: BuildInfo;
  changes?: ChangeFeed;
  collector?: Collector;
  jobs?: CollectionJobs;
  activity?: ActivityAccess;
  transfer?: VaultOperations;
  subscriptions?: readonly SubscriptionCollection[];
  schedule?: ScheduleManagement;
  search?: TranscriptSearch;
  pacing?: readonly Pacing[];
  connectivity?: ConnectivityAccess;
  webRoot?: string;
  agentToken?: string;
  agentAuthorize?: (header: string | undefined) => boolean;
  agentConnection?: AgentConnectionAccess;
  runtimeStatus?: () => CollectorRuntimeStatus;
  notReady?: () => string | null;
  vaultSetup?: VaultSetup;
  loginStartup?: LoginStartupAccess;
  updates?: UpdateAccess;
  notifications?: NotificationAccess;
  sourceTypes?: SourceTypeDeclaration[];
  allowedHosts?: string[];
}

const appDrains = new WeakMap<FastifyInstance, () => Promise<void>>();

export function waitForHttpAppIdle(app: FastifyInstance): Promise<void> {
  return appDrains.get(app)?.() ?? Promise.resolve();
}

export async function createHttpApp(options: HttpAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  // Set on each reply in the first hook: an answer without a matching route (404, or refused by a
  // hook) gets no app-level serializer from Fastify. A reply's own serializer leaves the content type
  // to the serializer. https://fastify.dev/docs/latest/Reference/Reply/#serializerfunc
  app.addHook('onRequest', async (_request, reply) => {
    void reply.serializer((payload) => {
      if (typeof payload === 'string') return maskSecrets(payload);
      if (!reply.hasHeader('content-type')) void reply.type('application/json; charset=utf-8');
      return maskSecretsJson(payload);
    });
  });
  const buildInfo = Object.freeze({ ...options.buildInfo ?? await loadBuildInfo() });
  const subscriptions = options.subscriptions ?? [];
  const network = networkGuard(options.connectivity);
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
    // https://en.wikipedia.org/wiki/DNS_rebinding
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

  if (options.agentAuthorize) {
    const agentAuthorize = options.agentAuthorize;
    app.addHook('onRequest', async (request, reply) => {
      if (!agentAuthorize(request.headers.authorization)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        error: { code: 'unauthorized', message: '請使用目前的 Agent 連線金鑰。' },
      });
    });
  } else if (options.agentToken !== undefined) {
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
      const access = request.routeOptions.config.vaultAccess;
      if (!request.url.startsWith('/api/') || access === 'device-data') return;
      const message = notReady();
      if (message) {
        return reply.code(503).send({ error: { code: 'vault_not_ready', message } });
      }
    });
  }

  if (options.changes) registerChangeRoutes(app, options.changes);

  if (options.vaultSetup) registerVaultSetupRoutes(app, options.vaultSetup);

  if (options.transfer) {
    const transfer = options.transfer;
    const writes = new WeakMap<object, () => void>();
    app.addHook('preHandler', async (request) => {
      if (!request.url.startsWith('/api/') || request.routeOptions.config.vaultAccess) return;
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
      writes.set(request, transfer.enterWrite());
    });
    app.addHook('onResponse', async (request) => { writes.get(request)?.(); });
    app.addHook('onSend', async (request, _reply, payload) => { writes.get(request)?.(); return payload; });
    app.addHook('onError', async (request) => { writes.get(request)?.(); });
    registerVaultTransferRoutes(app, transfer);
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
      void reply.status(errorStatus(options.sources, error.code)).send({
        error: { code: error.code, message: redact(error.message), ...(error.retryAt ? { retryAt: error.retryAt } : {}) },
      });
      return;
    }
    const requestStatus = requestErrorStatus(error);
    if (requestStatus !== null) {
      void reply.status(requestStatus).send({ error: { code: 'invalid_request', message: requestErrorMessage(requestStatus, error) } });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({
      error: { code: 'internal_error', message: '發生未預期的錯誤。' },
    });
  });

  const activity = options.activity;
  registerDeviceRoutes(app, {
    sources: options.sources, buildInfo, network,
    ...(options.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {}),
    ...(activity ? { activityHealth: () => activity.health() } : {}),
    ...(options.notifications ? { notifications: options.notifications } : {}),
    ...(options.updates ? { updates: options.updates } : {}),
    ...(options.loginStartup ? { loginStartup: options.loginStartup } : {}),
    ...(options.pacing ? { pacing: options.pacing } : {}),
  });
  if (options.agentConnection) registerAgentRoutes(app, options.agentConnection);
  registerDocumentRoutes(app, {
    sources: options.sources, subscriptions,
    ...(options.collector ? { collector: options.collector } : {}),
    ...(options.search ? { search: options.search } : {}),
  });
  if (options.jobs) registerJobRoutes(app, options.jobs, options.sources, network);
  if (activity) registerActivityRoutes(app, activity);
  if (options.schedule) registerScheduleRoutes(app, options.schedule, network);
  registerSubscriptionRoutes(app, {
    sources: options.sources, subscriptions, network,
    sourceTypes: options.sourceTypes ?? sourceTypeDeclarations(options.sources),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.collector ? { collector: options.collector } : {}),
    ...(activity ? { activity } : {}),
  });

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

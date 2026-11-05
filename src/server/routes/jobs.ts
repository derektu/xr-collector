import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import { CollectorError } from '../../core/collector-error.js';
import type { JobOverview, JobPage, JobSubmission, JobSummary, JobView } from '../../core/job-types.js';
import type { SourceRegistry } from '../../core/source-registry.js';
import { serve } from '../api-route.js';
import { ownedAddress, requiredUrl } from './addresses.js';
import type { NetworkGuard } from './network.js';
import { isInstant, pagination, singleValues } from './query-params.js';

/** Accepts collection work and answers job queries for the active Vault. */
export interface CollectionJobs {
  submit(type: string, url: string): Promise<JobSubmission>;
  submitItem(type: string, url: string): Promise<JobSubmission>;
  get(id: string): JobView;
  list(query: { state?: 'active' | 'all'; limit?: number; cursor?: string }): JobPage;
  summary(since: string): JobSummary;
  retry(id: string): Promise<JobSubmission>;
  /** The jobs page: running, queued and failed work. */
  overview(): Promise<JobOverview>;
  /** Removes a failed single item or subscription request from the failed section. */
  dismiss(id: string): Promise<JobView>;
}

/** Collection work: submitting an address or a single item, and reading, retrying and dismissing jobs. */
export function registerJobRoutes(app: FastifyInstance, jobs: CollectionJobs, sources: SourceRegistry, network: NetworkGuard): void {
  serve(app, API_ROUTES.submitAddress, async (request: FastifyRequest<{ Body: { url?: unknown } }>) => {
    const { type, input } = ownedAddress(sources, requiredUrl(request.body?.url, '請貼上要加入的網址。'));
    network.requireOnline();
    return await jobs.submit(type, input);
  });

  serve(app, API_ROUTES.collectItem, async (request: FastifyRequest<{ Body: { url?: unknown } }>) => {
    const { type, input } = ownedAddress(sources, requiredUrl(request.body?.url, '請貼上要收集的網址。'));
    network.requireOnline();
    return await jobs.submitItem(type, input);
  });

  serve(app, API_ROUTES.jobs, async (request: FastifyRequest<{ Querystring: { state?: string; limit?: string; cursor?: string } }>) => {
    const { state, cursor } = request.query;
    if (state !== undefined && state !== 'active' && state !== 'all') {
      throw new CollectorError('invalid_request', 'state 只能是 active 或 all。');
    }
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 100)) {
      throw new CollectorError('invalid_request', '分頁位置無效。');
    }
    const { limit } = pagination({ limit: request.query.limit ?? '20' });
    const page = jobs.list({ ...(state ? { state } : {}), limit, ...(cursor ? { cursor } : {}) });
    return page;
  });

  serve(app, API_ROUTES.jobSummary, async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>) => {
    const { since } = singleValues(request.query);
    if (since !== undefined && !isInstant(since)) throw new CollectorError('invalid_request', 'since 必須是 ISO 時間。');
    return { summary: jobs.summary(since ?? new Date(Date.now() - 86_400_000).toISOString()) };
  });

  serve(app, API_ROUTES.jobOverview, async () => ({ overview: await jobs.overview() }));

  serve(app, API_ROUTES.job, async (request: FastifyRequest<{ Params: { id: string } }>) => ({
    job: jobs.get(request.params.id),
  }));

  serve(app, API_ROUTES.retryJob, async (request: FastifyRequest<{ Params: { id: string } }>) => {
    network.requireOnline();
    return await jobs.retry(request.params.id);
  });

  serve(app, API_ROUTES.dismissJob, async (request: FastifyRequest<{ Params: { id: string } }>) => ({
    job: await jobs.dismiss(request.params.id),
  }));
}

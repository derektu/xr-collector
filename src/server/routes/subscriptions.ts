import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import type { ActivityCheckSummary } from '../../core/activity-types.js';
import { CollectorError } from '../../core/collector-error.js';
import type { Collector } from '../../core/collector.js';
import type { JobSubmission, JobView } from '../../core/job-types.js';
import type { SubscriptionDeclaration } from '../../core/source-contract.js';
import type { SourceRegistry } from '../../core/source-registry.js';
import type {
  PendingSubscription,
  Subscription,
  SubscriptionPreview,
  SubscriptionRecord,
  SubscriptionSettings,
} from '../../core/subscription-types.js';
import { SourceCatalog } from '../../sources/source-catalog.js';
import { recognizeUrl, sourceTypeInfo, type SourceTypeDeclaration } from '../../sources/source-types.js';
import { startChecks } from '../../subscriptions/subscription-service.js';
import { serve } from '../api-route.js';
import type { ActivityAccess } from './activity.js';
import { ownedAddress, requiredUrl } from './addresses.js';
import type { NetworkGuard } from './network.js';
import { singleValues } from './query-params.js';
import type { ScheduleManagement } from './schedule.js';

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
  /** The listed subscriptions a manual check covers; refuses a missing or paused one. */
  checkable(ids: readonly string[]): Promise<SubscriptionRecord[]>;
  startRun(request: { trigger: 'manual'; subscriptionIds?: string[] }): Promise<JobSubmission[]>;
  checkJobs(id: string): JobView[];
}

export interface SubscriptionRouteOptions {
  sources: SourceRegistry;
  /** The subscriptions of each source type with subscriptions; without any, only the source types are served. */
  subscriptions: readonly SubscriptionCollection[];
  /** The source types' address recognition. */
  sourceTypes: SourceTypeDeclaration[];
  network: NetworkGuard;
  /** Checks every subscription when a check names none. */
  schedule?: ScheduleManagement;
  collector?: Collector;
  activity?: ActivityAccess;
}

/**
 * Subscriptions of every source type: preview, add, change, remove and check them; the source types
 * and address recognition; and the subscription list and detail.
 */
export function registerSubscriptionRoutes(app: FastifyInstance, options: SubscriptionRouteOptions): void {
  const { sources, subscriptions, sourceTypes, network } = options;

  /** The subscriptions of a type, or `subscription_not_found` for a type without subscriptions. */
  const collectionOf = (type: string): { collection: SubscriptionCollection; subscription: SubscriptionDeclaration; targetNoun: string } => {
    const collection = subscriptions.find((candidate) => candidate.type === type);
    const subscription = sources.get(type)?.subscription;
    if (!collection || !subscription) throw new CollectorError('subscription_not_found', '找不到這個訂閱。');
    return { collection, subscription, targetNoun: subscription.targetNoun };
  };

  /** The type of a subscription address; an address of a type without subscriptions is not one. */
  const subscriptionAddress = (url: unknown): { type: string; input: string } & ReturnType<typeof collectionOf> => {
    const { type, input } = ownedAddress(sources, requiredUrl(url, '請貼上要訂閱的網址。'));
    if (!subscriptions.some((candidate) => candidate.type === type)) {
      throw new CollectorError('invalid_subscription', '這個網址不能訂閱。');
    }
    return { type, input, ...collectionOf(type) };
  };

  if (subscriptions.length > 0) {
    serve(app, API_ROUTES.previewSubscription, async (request: FastifyRequest<{ Body: { url?: unknown } }>) => {
      const { collection, input } = subscriptionAddress(request.body?.url);
      network.requireOnline();
      return { preview: await network.confirmingNetwork(() => collection.preview(input)) };
    });

    serve(app, API_ROUTES.subscribe, async (request: FastifyRequest<{ Body: { url?: unknown; settings?: unknown } }>) => {
      const { collection, subscription, input } = subscriptionAddress(request.body?.url);
      const settings = request.body.settings === undefined ? {} : subscription.parseSettingsPatch(request.body.settings, { allowEmpty: true });
      network.requireOnline();
      return await collection.add(input, settings);
    });

    // Settings change first, so the check a resume in the same request starts uses the new range.
    serve(app, API_ROUTES.updateSubscription, async (request: FastifyRequest<{
      Params: { type: string; id: string };
      Body: { enabled?: unknown; settings?: unknown } | null;
    }>) => {
      const { collection, subscription, targetNoun } = collectionOf(request.params.type);
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CollectorError('invalid_request', `${targetNoun}設定必須是 JSON 物件。`);
      const unknown = Object.keys(body).find((key) => key !== 'enabled' && key !== 'settings');
      if (unknown) throw new CollectorError('invalid_request', `不支援的欄位：${unknown}`);
      if (body.enabled === undefined && body.settings === undefined) throw new CollectorError('invalid_request', '請提供 enabled 或 settings。');
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new CollectorError('invalid_request', `${targetNoun}啟用設定無效。`);
      if (typeof body.enabled !== 'boolean') {
        return { subscription: await collection.updateSettings(request.params.id, subscription.parseSettingsPatch(body.settings)), submission: null };
      }
      if (body.settings !== undefined) await collection.updateSettings(request.params.id, subscription.parseSettingsPatch(body.settings));
      const { subscription: record, submission } = await collection.setEnabled(request.params.id, body.enabled);
      return { subscription: record, submission };
    });

    serve(app, API_ROUTES.applySubscriptionSettings, async (request: FastifyRequest<{ Params: { type: string; id: string } }>) =>
      collectionOf(request.params.type).collection.applySettingsToAll(request.params.id));

    // `documents=keep` (the default) leaves the subscription's documents; `documents=delete` deletes them.
    serve(app, API_ROUTES.removeSubscription, async (request: FastifyRequest<{ Params: { type: string; id: string }; Querystring: Record<string, unknown> }>) => {
      const { collection } = collectionOf(request.params.type);
      const { documents = 'keep' } = singleValues(request.query);
      if (documents !== 'keep' && documents !== 'delete') throw new CollectorError('invalid_request', 'documents 只接受 keep 或 delete。');
      const { documentsKept, documentsDeleted, documentsFailed } = await collection.remove(request.params.id, { documents });
      return { removed: true, documentsKept, documentsDeleted, documentsFailed };
    });

    serve(app, API_ROUTES.checkSubscriptions, async (request: FastifyRequest<{ Body?: { subscriptions?: unknown } | null }>) => {
      const body = request.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) throw new CollectorError('invalid_request', '檢查範圍必須是 JSON 物件。');
      const unknown = Object.keys(body).find((key) => key !== 'subscriptions');
      if (unknown) throw new CollectorError('invalid_request', `不支援的欄位：${unknown}`);
      const listed = body.subscriptions;
      if (listed !== undefined && (!Array.isArray(listed) || listed.length === 0 || !listed.every(isSubscriptionKey))) {
        throw new CollectorError('invalid_request', 'subscriptions 必須是非空的 {type, id} 清單。');
      }
      await network.confirmOnline();
      if (listed === undefined) {
        // Checking every subscription goes through the scheduler, which refuses while a Vault operation runs.
        if (!options.schedule) throw new CollectorError('invalid_request', '沒有可檢查的訂閱。');
        const submissions = await options.schedule.runNow();
        return { submissions };
      }
      const submissions = await startChecks(sources, (type) => collectionOf(type).collection, listed);
      return { submissions };
    });
  }

  serve(app, API_ROUTES.sourceTypes, async () => ({ sourceTypes: sourceTypes.map(sourceTypeInfo) }));

  if (subscriptions.length > 0) {
    const activity = options.activity;
    const catalog = new SourceCatalog(sources, sourceTypes, subscriptions, async () => await options.collector?.list() ?? [],
      activity?.summary ? async (type, id) => {
        const summaries: ActivityCheckSummary[] = [];
        let cursor: string | undefined;
        do {
          const page = await activity.summary!({ view: 'summary', sourceType: type, subscriptionId: id, limit: 100, ...(cursor ? { cursor } : {}) });
          summaries.push(...page.entries.filter((entry) => entry.kind === 'check'));
          cursor = page.nextCursor ?? undefined;
        } while (cursor && summaries.length < 30);
        return summaries.slice(0, 30);
      } : undefined);
    const previewSubscription = (type: string, url: string): Promise<SubscriptionPreview> =>
      network.confirmingNetwork(() => collectionOf(type).collection.preview(url));

    // Every address answers 200 with a status; only a missing address is a malformed request.
    serve(app, API_ROUTES.recognizeUrl, async (request: FastifyRequest<{ Body: { url?: unknown } }>) => {
      if (typeof request.body?.url !== 'string' || request.body.url.trim() === '') {
        throw new CollectorError('invalid_request', '請貼上要加入的網址。');
      }
      network.requireOnline();
      return { recognition: await recognizeUrl(request.body.url, sourceTypes, { previewSubscription }) };
    });

    serve(app, API_ROUTES.subscriptions, async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>) => {
      const query = singleValues(request.query);
      const unknown = Object.keys(query).find((key) => key !== 'type');
      if (unknown) throw new CollectorError('invalid_request', `不支援的查詢參數：${unknown}`);
      if (query.type !== undefined && !subscriptions.some((collection) => collection.type === query.type)) {
        throw new CollectorError('invalid_request', '不支援的 type。');
      }
      return catalog.list(query.type);
    });

    serve(app, API_ROUTES.subscription, async (request: FastifyRequest<{ Params: { type: string; id: string } }>) =>
      catalog.detail(request.params.type, request.params.id));
  }
}

function isSubscriptionKey(value: unknown): value is { type: string; id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { type, id } = value as Record<string, unknown>;
  return Object.keys(value).every((key) => key === 'type' || key === 'id')
    && typeof type === 'string' && type.length > 0 && typeof id === 'string' && id.length > 0;
}

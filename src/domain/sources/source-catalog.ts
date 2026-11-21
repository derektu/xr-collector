import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { ActivityCheckSummary } from '../../shared/activity/activity-types.js';
import type { JobView, SkipReason } from '../../shared/jobs/job-types.js';
import type { DocumentMetadata } from '../../shared/documents/document-types.js';
import { MAX_CHECK_ATTEMPTS } from '../../shared/subscriptions/subscription-limits.js';
import type {
  PendingSubscription,
  SubscriptionCollectionEntry,
  SubscriptionEntry,
  SubscriptionList,
  Subscription,
  SubscriptionDetail,
} from '../../shared/subscriptions/subscription-types.js';
import type { SourceTypeDeclaration } from './source-types.js';

export const COLLECTION_LIMIT = 30;

const UNLISTED_SKIPS: ReadonlySet<SkipReason> = new Set(['subscription_paused', 'subscription_removed', 'superseded']);

export interface CatalogSubscriptions {
  readonly type: string;
  listSubscriptions(): Promise<Subscription[]>;
  checkJobs(id: string): JobView[];
  pendingSubscriptions?(): Promise<PendingSubscription[]>;
}

export class SourceCatalog {
  constructor(
    private readonly sources: SourceRegistry,
    private readonly declarations: SourceTypeDeclaration[],
    private readonly subscriptions: readonly CatalogSubscriptions[],
    private readonly documents: () => Promise<DocumentMetadata[]>,
    private readonly checkSummaries?: (type: string, id: string) => Promise<ActivityCheckSummary[]>,
  ) {}

  async list(type?: string): Promise<SubscriptionList> {
    const collections = type === undefined ? this.subscriptions : this.subscriptions.filter((collection) => collection.type === type);
    const declarations = type === undefined ? this.declarations : this.declarations.filter((declaration) => declaration.id === type);
    const [listed, documents, pendingLists] = await Promise.all([
      Promise.all(collections.map(async (collection) => ({ collection, list: await collection.listSubscriptions() }))),
      this.documents(),
      Promise.all(collections.map((collection) => collection.pendingSubscriptions?.() ?? Promise.resolve([]))),
    ]);
    const subscribed = new Map(listed.map(({ collection, list }) =>
      [collection.type, new Set(list.map((subscription) => subscription.id))]));
    let documentCount = 0;
    let lastCollectedAt: string | null = null;
    for (const document of documents) {
      if (type !== undefined && document.sourceType !== type) continue;
      if (document.publisher.id && subscribed.get(document.sourceType)?.has(document.publisher.id)) continue;
      documentCount += 1;
      if (!lastCollectedAt || document.collectedAt > lastCollectedAt) lastCollectedAt = document.collectedAt;
    }
    const subscriptions = listed.flatMap(({ collection, list }) =>
      list.map((subscription) => this.entry(collection.type, subscription)));
    return {
      subscriptions,
      pending: pendingLists.flat(),
      unsubscribed: { documentCount, lastCollectedAt },
      types: declarations.map((declaration) => ({
        type: declaration.id,
        count: subscriptions.filter((subscription) => subscription.type === declaration.id).length,
      })),
    };
  }

  async detail(type: string, id: string): Promise<SubscriptionDetail> {
    const collection = this.subscriptions.find((candidate) => candidate.type === type);
    if (!collection) throw new CollectorError('subscription_not_found', '找不到這個訂閱。');
    const subscription = (await collection.listSubscriptions()).find((candidate) => candidate.id === id);
    if (!subscription) throw new CollectorError('subscription_not_found', '找不到這個訂閱。');
    const documents = (await this.documents())
      .filter((document) => document.sourceType === type && document.publisher.id === id);
    const summaries = await this.checkSummaries?.(type, id);
    return {
      subscription: this.entry(type, subscription),
      collection: collectionRecord(this.sources, type, subscription, documents, collection.checkJobs(id), summaries),
    };
  }

  private entry(type: string, subscription: Subscription): SubscriptionEntry {
    const declaration = this.declarations.find((candidate) => candidate.id === type);
    const kind = declaration?.kinds.find((candidate) => candidate.capability === 'subscription');
    return { ...subscription, type, kind: kind?.id ?? type, kindLabel: kind?.label ?? declaration?.label ?? type };
  }
}

export function collectionRecord(
  sources: SourceRegistry, type: string, subscription: Subscription, documents: readonly DocumentMetadata[], checks: readonly JobView[],
  summaries?: readonly ActivityCheckSummary[],
): SubscriptionCollectionEntry[] {
  const definition = sources.definition(type);
  const keyField = definition?.storage?.outOfRangeKeyField;
  const entries: SubscriptionCollectionEntry[] = documents.map((document) => ({
    kind: 'collected', at: document.collectedAt, key: document.sourceId, title: document.title, documentId: document.id,
  }));
  const collected = new Set(documents.map((document) => document.sourceId));
  if (keyField) {
    for (const failure of subscription.failures ?? []) {
      const key = String(failure[keyField]);
      if (collected.has(key)) continue;
      const reason = definition?.failureLabels?.[failure.errorCode] ?? '收集失敗';
      const common = {
        at: failure.failedAt, key, title: failure.title, url: failure.url ?? definition?.item.urlForKey?.(key) ?? '', errorCode: failure.errorCode, reason,
        attempts: failure.attempts,
      };
      entries.push(failure.skipped
        ? { kind: 'skipped', ...common, skippedBy: definition?.classifyFailure({ code: failure.errorCode }) === 'skip' ? 'failure' : 'limit' }
        : { kind: 'failed', ...common, maxAttempts: MAX_CHECK_ATTEMPTS });
    }
  }
  for (const summary of summaries ?? []) {
    if (summary.count === 1) {
      entries.push({
        kind: 'check', at: summary.lastFinishedAt, jobId: summary.jobId, groupId: summary.groupId,
        trigger: summary.trigger, created: summary.created, failed: summary.failed,
        error: summary.severity === 'error' || summary.errorCode
          ? { code: summary.errorCode ?? 'collection_failed', message: summary.message } : null,
      });
    } else entries.push({
      kind: 'check-group', at: summary.lastFinishedAt, firstAt: summary.firstFinishedAt, groupId: summary.groupId,
      trigger: summary.trigger, result: summary.result, count: summary.count,
      ...(summary.errorCode ? { errorCode: summary.errorCode } : {}), message: summary.message,
    });
  }
  for (const job of summaries === undefined ? checks : []) {
    if (!job.finishedAt || (job.state !== 'completed' && job.state !== 'failed')) continue;
    if (job.result?.skipReason && UNLISTED_SKIPS.has(job.result.skipReason)) continue;
    entries.push({
      kind: 'check', at: job.finishedAt, jobId: job.id, trigger: job.scope?.trigger ?? null,
      created: job.progress?.created ?? 0, failed: job.progress?.failed ?? 0,
      error: job.state === 'failed' ? job.error : null,
    });
  }
  return entries
    .sort((left, right) => right.at.localeCompare(left.at) || Number(isCheckRow(right)) - Number(isCheckRow(left)))
    .slice(0, COLLECTION_LIMIT);
}

function isCheckRow(entry: SubscriptionCollectionEntry): boolean {
  return entry.kind === 'check' || entry.kind === 'check-group';
}

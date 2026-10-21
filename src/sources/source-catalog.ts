import {
  CollectorError,
  type CollectionJob,
  type DocumentMetadata,
  type PendingSubscription,
  type SubscriptionEntry,
  type SubscriptionJobRecord,
  type SubscriptionList,
  type Subscription,
  type SubscriptionDetail,
} from '../core/types.js';
import type { SourceTypeDeclaration } from './source-types.js';

const RECENT_LIMIT = 5;

/** What the catalog reads from the subscriptions of one source type. */
export interface CatalogSubscriptions {
  readonly type: string;
  listSubscriptions(): Promise<Subscription[]>;
  checkJobs(id: string): CollectionJob[];
  pendingSubscriptions?(): Promise<PendingSubscription[]>;
}

/**
 * Subscriptions as one list across source types, or the subscriptions of one type. A document
 * belongs to the subscription of its type whose target published it, including items collected one
 * by one from a subscribed target; documents of no current subscription form the separate
 * single-item summary.
 */
export class SourceCatalog {
  constructor(
    private readonly declarations: SourceTypeDeclaration[],
    private readonly subscriptions: readonly CatalogSubscriptions[],
    private readonly documents: () => Promise<DocumentMetadata[]>,
  ) {}

  /** Every type's subscriptions, or with `type` only that type's, with the documents and counts of the same scope. */
  async list(type?: string): Promise<SubscriptionList> {
    const collections = type === undefined ? this.subscriptions : this.subscriptions.filter((collection) => collection.type === type);
    const declarations = type === undefined ? this.declarations : this.declarations.filter((declaration) => declaration.id === type);
    const [lists, documents, pendingLists] = await Promise.all([
      Promise.all(collections.map((collection) => collection.listSubscriptions())),
      this.documents(),
      Promise.all(collections.map((collection) => collection.pendingSubscriptions?.() ?? Promise.resolve([]))),
    ]);
    const subscribed = new Map(collections.map((collection, index) =>
      [collection.type, new Set(lists[index]!.map((subscription) => subscription.id))]));
    let documentCount = 0;
    let lastCollectedAt: string | null = null;
    for (const document of documents) {
      if (type !== undefined && document.sourceType !== type) continue;
      if (document.publisher.id && subscribed.get(document.sourceType)?.has(document.publisher.id)) continue;
      documentCount += 1;
      if (!lastCollectedAt || document.collectedAt > lastCollectedAt) lastCollectedAt = document.collectedAt;
    }
    const subscriptions = collections.flatMap((collection, index) =>
      lists[index]!.map((subscription) => this.entry(collection.type, subscription)));
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
      .filter((document) => document.sourceType === type && document.publisher.id === id)
      .sort((left, right) => right.collectedAt.localeCompare(left.collectedAt) || left.id.localeCompare(right.id));
    return {
      subscription: this.entry(type, subscription),
      recentDocuments: documents.slice(0, RECENT_LIMIT),
      recentJobs: collection.checkJobs(id).slice(0, RECENT_LIMIT).map(jobRecord),
    };
  }

  private entry(type: string, subscription: Subscription): SubscriptionEntry {
    const declaration = this.declarations.find((candidate) => candidate.id === type);
    const kind = declaration?.kinds.find((candidate) => candidate.capability === 'subscription');
    return { ...subscription, type, kind: kind?.id ?? type, kindLabel: kind?.label ?? declaration?.label ?? type };
  }
}

function jobRecord(job: CollectionJob): SubscriptionJobRecord {
  return {
    id: job.id,
    state: job.state,
    trigger: job.scope?.trigger ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    outcome: job.result?.outcome ?? null,
    error: job.error,
    retry: job.retry ?? null,
    resumedCount: job.recovery?.resumedCount ?? 0,
  };
}

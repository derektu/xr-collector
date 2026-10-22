import { sourceDefinition } from '../core/source-registry.js';
import {
  CollectorError,
  type CollectionJob,
  type DocumentMetadata,
  MAX_CHECK_ATTEMPTS,
  type PendingSubscription,
  type SkipReason,
  type SubscriptionCollectionEntry,
  type SubscriptionEntry,
  type SubscriptionList,
  type Subscription,
  type SubscriptionDetail,
} from '../core/types.js';
import type { SourceTypeDeclaration } from './source-types.js';

/** Rows a subscription's collection record shows. */
export const COLLECTION_LIMIT = 30;

/** Checks that stopped for these reasons collected nothing on their own and are left out of the record. */
const UNLISTED_SKIPS: ReadonlySet<SkipReason> = new Set(['subscription_paused', 'subscription_removed', 'superseded']);

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
      .filter((document) => document.sourceType === type && document.publisher.id === id);
    return {
      subscription: this.entry(type, subscription),
      collection: collectionRecord(type, subscription, documents, collection.checkJobs(id)),
    };
  }

  private entry(type: string, subscription: Subscription): SubscriptionEntry {
    const declaration = this.declarations.find((candidate) => candidate.id === type);
    const kind = declaration?.kinds.find((candidate) => candidate.capability === 'subscription');
    return { ...subscription, type, kind: kind?.id ?? type, kindLabel: kind?.label ?? declaration?.label ?? type };
  }
}

/**
 * A subscription's collection record, newest first: its documents, the items its checks failed to
 * collect or skipped (an item with a document shows as collected), and a summary of each finished
 * check. Checks still running, interrupted, or stopped by a pause, a removal or a later job are left out.
 */
export function collectionRecord(
  type: string, subscription: Subscription, documents: readonly DocumentMetadata[], checks: readonly CollectionJob[],
): SubscriptionCollectionEntry[] {
  const definition = sourceDefinition(type);
  const keyField = definition?.storage?.outOfRangeKeyField;
  const entries: SubscriptionCollectionEntry[] = documents.map((document) => ({
    kind: 'collected', at: document.collectedAt, key: document.sourceId, title: document.title, documentId: document.id,
  }));
  const collected = new Set(documents.map((document) => document.sourceId));
  for (const failure of keyField ? subscription.failures ?? [] : []) {
    const key = String(failure[keyField!]);
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
  for (const job of checks) {
    if (!job.finishedAt || (job.state !== 'completed' && job.state !== 'failed')) continue;
    if (job.result?.skipReason && UNLISTED_SKIPS.has(job.result.skipReason)) continue;
    entries.push({
      kind: 'check', at: job.finishedAt, jobId: job.id, trigger: job.scope?.trigger ?? null,
      created: job.progress?.created ?? 0, failed: job.progress?.failed ?? 0,
      error: job.state === 'failed' ? job.error : null,
    });
  }
  // A check finishes after the items it collected, so at the same instant it comes first.
  return entries
    .sort((left, right) => right.at.localeCompare(left.at) || Number(right.kind === 'check') - Number(left.kind === 'check'))
    .slice(0, COLLECTION_LIMIT);
}

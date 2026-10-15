import {
  CollectorError,
  type CollectionJob,
  type DocumentMetadata,
  type SourceDetail,
  type SourceEntry,
  type SourceJobRecord,
  type SourceList,
  type Subscription,
} from '../core/types.js';
import type { SourceTypeDeclaration } from './source-types.js';

const RECENT_LIMIT = 5;

/** What the catalog reads from the channel service. */
export interface CatalogChannels {
  listSubscriptions(): Promise<Subscription[]>;
  channelJobs(id: string): CollectionJob[];
}

/**
 * Sources as one list across source types. A document belongs to the subscription whose channel
 * published it, including items collected one by one from a subscribed channel; documents of no
 * current subscription form the separate single-item summary.
 */
export class SourceCatalog {
  constructor(
    private readonly declarations: SourceTypeDeclaration[],
    private readonly channels: CatalogChannels,
    private readonly documents: () => Promise<DocumentMetadata[]>,
  ) {}

  async list(): Promise<SourceList> {
    const [subscriptions, documents] = await Promise.all([this.channels.listSubscriptions(), this.documents()]);
    const subscribed = new Set(subscriptions.map((subscription) => subscription.id));
    let documentCount = 0;
    let lastCollectedAt: string | null = null;
    for (const document of documents) {
      if (document.sourceType === 'youtube' && document.publisher.id && subscribed.has(document.publisher.id)) continue;
      documentCount += 1;
      if (!lastCollectedAt || document.collectedAt > lastCollectedAt) lastCollectedAt = document.collectedAt;
    }
    const sources = subscriptions.map((subscription) => this.entry(subscription));
    return {
      sources,
      unsubscribed: { documentCount, lastCollectedAt },
      types: this.declarations.map((declaration) => ({
        type: declaration.id,
        count: sources.filter((source) => source.type === declaration.id).length,
      })),
    };
  }

  async detail(type: string, id: string): Promise<SourceDetail> {
    if (type !== 'youtube') throw new CollectorError('channel_not_found', '找不到這個來源。');
    const subscription = (await this.channels.listSubscriptions()).find((candidate) => candidate.id === id);
    if (!subscription) throw new CollectorError('channel_not_found', '找不到這個來源。');
    const documents = (await this.documents())
      .filter((document) => document.sourceType === 'youtube' && document.publisher.id === id)
      .sort((left, right) => right.collectedAt.localeCompare(left.collectedAt) || left.id.localeCompare(right.id));
    return {
      source: this.entry(subscription),
      recentDocuments: documents.slice(0, RECENT_LIMIT),
      recentJobs: this.channels.channelJobs(id).slice(0, RECENT_LIMIT).map(jobRecord),
    };
  }

  private entry(subscription: Subscription): SourceEntry {
    const kind = this.declarations.find((declaration) => declaration.id === 'youtube')?.kinds.find((candidate) => candidate.id === 'channel');
    return { ...subscription, type: 'youtube', kind: 'channel', kindLabel: kind?.label ?? 'YouTube 頻道' };
  }
}

function jobRecord(job: CollectionJob): SourceJobRecord {
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

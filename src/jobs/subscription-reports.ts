import { roleOf, subscriptionOf } from '../core/job-role.js';
import type { SourceDeclarations } from '../core/source-registry.js';
import type { FailureClass, SubscriptionTarget } from '../core/source-contract.js';
import { MAX_CHECK_ATTEMPTS } from '../core/subscription-limits.js';
import type { CollectionJob, JobError, SkipReason } from '../core/job-types.js';
import type { ItemFailureEntry } from '../core/subscription-types.js';
import type { NewJobEvent } from '../core/activity-types.js';
import { INTERRUPTED_REPEATEDLY } from './job-recovery.js';
import type { CheckEnd, SubscriptionPort } from './subscription-port.js';

/** Why a check stops without ending: its subscription was paused or removed, or a later job took over. */
const STOP_REASONS: ReadonlySet<SkipReason> = new Set(['subscription_paused', 'subscription_removed', 'superseded']);

/** What the reports read from the job manager. */
export interface ReportHost {
  sources: SourceDeclarations;
  /** The subscription port; throws for a manager that runs no subscription work. */
  port(): SubscriptionPort;
  /** A job's parent, live or stored. */
  parentOf(id: string): CollectionJob | undefined;
  /** How the job's source type treats a failure. */
  classify(job: CollectionJob, error: { code: string }): FailureClass;
  /** What the job's source type calls a failure with this code; undefined without a label. */
  failureLabel(type: string, code: string): string | undefined;
  /** Whether a pause or removal stopped this running check. */
  stoppedCheck(id: string): boolean;
  /** Records an event of the job. */
  event(job: CollectionJob, entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void;
}

/**
 * Turns what happens to check jobs and their items into reports to the subscriptions: an item
 * collected, failed for good or out of range, and how a check ended. An item submitted on its own
 * reports nothing. What only the job knows is decided here: how the source type treats a failure,
 * and whether a pause, a removal or repeated interruptions stopped a check. Whether a failure counts
 * against the subscription, and how the subscription records it, is the subscriptions' rule.
 */
export class SubscriptionReports {
  constructor(private readonly host: ReportHost) {}

  /** The target of the subscription whose check found an item; undefined for an item submitted on its own. */
  targetOf(item: CollectionJob): SubscriptionTarget | undefined {
    const parent = item.parentId ? this.host.parentOf(item.parentId) : undefined;
    if (!parent || roleOf(this.host.sources, parent) !== 'check' || !parent.source.id) return undefined;
    return { id: parent.source.id, title: parent.source.title ?? '', url: parent.source.url };
  }

  /** Reports a check item's range start that its publish time came before. */
  async outOfRange(item: CollectionJob): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target || !item.publishedNotBefore) return;
    await this.host.port().itemOutOfRange(target.type, target.subscriptionId, target.key, item.publishedNotBefore);
  }

  /** Reports a collected check item. */
  async collected(item: CollectionJob): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target) return;
    await quietly(() => this.host.port().itemCollected(target.type, target.subscriptionId, target.key));
  }

  /**
   * Reports a check item that failed for good within this job, with its source's failure class, and
   * records an event of the failure count the subscription keeps across checks. A failure the
   * subscription does not count records no event.
   */
  async failed(item: CollectionJob, error: JobError, failureClass: FailureClass): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target) return;
    let entry: ItemFailureEntry | null = null;
    // A failure record that cannot be written leaves the item to be tried as if it had not failed.
    await quietly(async () => {
      entry = await this.host.port().itemFailed(target.type, target.subscriptionId, {
        key: target.key, title: item.source.title, url: item.source.url,
      }, error, failureClass);
    });
    const recorded = entry as ItemFailureEntry | null;
    if (!recorded) return;
    const label = this.host.failureLabel(item.source.type, error.code) ?? '收集失敗';
    const name = item.source.title ? `「${item.source.title}」` : item.source.url;
    const named = item.source.title ? { namesSource: true as const } : {};
    this.host.event(item, recorded.skipped
      ? {
        eventType: 'subscription.item_skipped', outcome: 'skipped', errorCode: error.code, attempt: recorded.attempts,
        message: `${name}已略過・${failureClass === 'skip' ? label : `已試 ${recorded.attempts} 次`}`, ...named,
      }
      : {
        eventType: 'subscription.item_failed', errorCode: error.code, attempt: recorded.attempts,
        message: `${name}${label}・已試 ${recorded.attempts}/${MAX_CHECK_ATTEMPTS} 次`, ...named,
      });
  }

  /**
   * How a finished check ended for its subscription; null for a check a pause, a removal or a later
   * job skipped before it collected anything, and for a retry of earlier items, which lists nothing.
   */
  checkEnd(job: CollectionJob): CheckEnd | null {
    if (roleOf(this.host.sources, job) !== 'check' || !job.source.id || !job.finishedAt || job.checkpoint?.retryItems) return null;
    if (job.state !== 'completed' && job.state !== 'failed') return null;
    if (job.result?.skipReason && STOP_REASONS.has(job.result.skipReason)) return null;
    const error = job.state === 'failed' ? job.error ?? null : null;
    const failureClass = error ? this.host.classify(job, error) : null;
    const counted = !this.host.stoppedCheck(job.id) && (job.state === 'completed' || (error !== null && error.code !== INTERRUPTED_REPEATEDLY));
    return { at: job.finishedAt, error, failureClass, counted };
  }

  /** The check job's subscription an item job collects for, with the item's key; null for any other job. */
  private checkItemOf(item: CollectionJob): { type: string; subscriptionId: string; key: string } | null {
    if (roleOf(this.host.sources, item) !== 'item' || !item.source.id) return null;
    const subscriptionId = subscriptionOf(this.host.sources, item, (id) => this.host.parentOf(id));
    return subscriptionId ? { type: item.source.type, subscriptionId, key: item.source.id } : null;
  }
}

async function quietly(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.error('Subscription failure record update failed', error);
  }
}

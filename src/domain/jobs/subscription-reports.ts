import { roleOf, subscriptionOf } from '../../shared/jobs/job-role.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { FailureClass, SubscriptionTarget } from '../../shared/sources/source-contract.js';
import { MAX_CHECK_ATTEMPTS } from '../../shared/subscriptions/subscription-limits.js';
import type { CollectionJob, JobError, SkipReason } from '../../shared/jobs/job-types.js';
import type { NewJobEvent } from '../../shared/activity/activity-types.js';
import { INTERRUPTED_REPEATEDLY } from './job-recovery.js';
import type { CheckEnd, SubscriptionPort } from './subscription-port.js';
import type { LogWriter } from '../../shared/log/log-types.js';

const STOP_REASONS: ReadonlySet<SkipReason> = new Set(['subscription_paused', 'subscription_removed']);
const NOT_SOURCE_FAILURES: ReadonlySet<string> = new Set([INTERRUPTED_REPEATEDLY, 'jobs_write_failed']);

function isSourceFailure(error: JobError): boolean {
  return !NOT_SOURCE_FAILURES.has(error.code);
}

export interface ReportHost {
  sources: SourceDeclarations;
  log: LogWriter;
  port(): SubscriptionPort;
  parentOf(id: string): CollectionJob | undefined;
  classify(job: CollectionJob, error: { code: string }): FailureClass;
  failureLabel(type: string, code: string): string | undefined;
  stoppedCheck(id: string): boolean;
  event(job: CollectionJob, entry: Omit<NewJobEvent, 'vaultPath' | 'jobId'>): void;
}

export class SubscriptionReports {
  constructor(private readonly host: ReportHost) {}

  targetOf(item: CollectionJob): SubscriptionTarget | undefined {
    const parent = item.parentId ? this.host.parentOf(item.parentId) : undefined;
    if (!parent || roleOf(this.host.sources, parent) !== 'check' || !parent.source.id) return undefined;
    return { id: parent.source.id, title: parent.source.title ?? '', url: parent.source.url };
  }

  async outOfRange(item: CollectionJob): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target || !item.publishedNotBefore) return;
    await this.host.port().itemOutOfRange(target.type, target.subscriptionId, target.key, item.publishedNotBefore);
  }

  async collected(item: CollectionJob): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target) return;
    await nullOnWriteFailure(this.host.log, () => this.host.port().itemCollected(target.type, target.subscriptionId, target.key));
  }

  async failed(item: CollectionJob, error: JobError, failureClass: FailureClass): Promise<void> {
    const target = this.checkItemOf(item);
    if (!target || !isSourceFailure(error)) return;
    const recorded = await nullOnWriteFailure(this.host.log, () => this.host.port().itemFailed(target.type, target.subscriptionId, {
      key: target.key, title: item.source.title, url: item.source.url,
    }, error, failureClass));
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

  checkEnd(job: CollectionJob): CheckEnd | null {
    if (roleOf(this.host.sources, job) !== 'check' || !job.source.id || !job.finishedAt) return null;
    if (job.state !== 'completed' && job.state !== 'failed') return null;
    if (job.result?.skipReason && STOP_REASONS.has(job.result.skipReason)) return null;
    const error = job.state === 'failed' ? job.error ?? null : null;
    const failureClass = error ? this.host.classify(job, error) : null;
    const counted = !this.host.stoppedCheck(job.id) && (job.state === 'completed' || (error !== null && isSourceFailure(error)));
    return { at: job.finishedAt, error, failureClass, counted };
  }

  private checkItemOf(item: CollectionJob): { type: string; subscriptionId: string; key: string } | null {
    if (roleOf(this.host.sources, item) !== 'item' || !item.source.id) return null;
    const subscriptionId = subscriptionOf(this.host.sources, item, (id) => this.host.parentOf(id));
    return subscriptionId ? { type: item.source.type, subscriptionId, key: item.source.id } : null;
  }
}

async function nullOnWriteFailure<T>(log: LogWriter, write: () => Promise<T>): Promise<T | null> {
  try {
    return await write();
  } catch (error) {
    log.write({ level: 'error', source: 'jobs', message: 'Subscription failure record update failed', error });
    return null;
  }
}

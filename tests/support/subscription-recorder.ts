import { requireDefinition } from '../../src/core/source-registry.js';
import type { ItemFailureEntry, JobError, JobSubmission, SkipReason, SubscriptionSettings } from '../../src/core/types.js';
import type { JobManager } from '../../src/jobs/job-manager.js';
import type { CheckPlan, CheckReport, SubscribeResult, SubscriptionPort } from '../../src/jobs/subscription-port.js';
import type { FailureClass, SubscriptionTarget } from '../../src/plugins/types.js';

/** A subscription as the recorder holds it. */
export interface RecordedSubscription extends SubscriptionTarget {
  type: string;
  enabled: boolean;
  settings: SubscriptionSettings;
  /** Item keys a check plans to leave out; the subscriptions decide them, so tests set them directly. */
  excluded: Set<string>;
}

/** One call a job manager made to the port, in call order. */
export type PortReport =
  | { kind: 'checked'; type: string; id: string; at: string; candidates?: string[]; collecting?: string[] }
  | { kind: 'collected'; type: string; id: string; key: string }
  | { kind: 'failed'; type: string; id: string; key: string; title: string | null; errorCode: string; failureClass: FailureClass }
  | { kind: 'outOfRange'; type: string; id: string; key: string; before: string }
  | { kind: 'subscribed'; type: string; id: string; outcome: 'created' | 'existing'; resumed: boolean }
  | { kind: 'checkNow'; type: string; id: string };

/**
 * An in-memory subscription port for job manager tests: it holds subscriptions the test adds,
 * plans checks from the source type's range rule and the test's exclusions, records every report,
 * and dispatches a new subscription's first check through the job manager it is attached to.
 */
export class SubscriptionRecorder implements SubscriptionPort {
  readonly subscriptions = new Map<string, RecordedSubscription>();
  readonly reports: PortReport[] = [];
  /** Failed checks per item key, so a reported failure gets a count as the subscriptions would give it. */
  private readonly failures = new Map<string, number>();
  /** Set to make the next subscribe write its subscription and then never return, as a process killed right after. */
  hangAfterSubscribe = false;
  /** Set to make the next check report never return and record nothing, as a process killed before the write. */
  hangOnChecked = false;
  private jobs: JobManager | null = null;

  /** The job manager a subscribe or manual check dispatches to. */
  attach(jobs: JobManager): this {
    this.jobs = jobs;
    return this;
  }

  add(type: string, target: SubscriptionTarget, options: { enabled?: boolean; settings?: Partial<SubscriptionSettings> } = {}): RecordedSubscription {
    const subscription: RecordedSubscription = {
      type, id: target.id, title: target.title, url: target.url, enabled: options.enabled ?? true,
      settings: { ...requireDefinition(type).subscription!.defaults, ...options.settings } as SubscriptionSettings,
      excluded: new Set(),
    };
    this.subscriptions.set(key(type, target.id), subscription);
    return subscription;
  }

  get(type: string, id: string): RecordedSubscription | undefined {
    return this.subscriptions.get(key(type, id));
  }

  remove(type: string, id: string): void {
    this.subscriptions.delete(key(type, id));
  }

  /** The reports of one kind. */
  of<K extends PortReport['kind']>(kind: K): Array<Extract<PortReport, { kind: K }>> {
    return this.reports.filter((report): report is Extract<PortReport, { kind: K }> => report.kind === kind);
  }

  async planCheck(type: string, id: string, at: Date): Promise<CheckPlan | { stopped: SkipReason }> {
    const subscription = this.get(type, id);
    if (!subscription?.enabled) return { stopped: subscription ? 'subscription_paused' : 'subscription_removed' };
    return {
      target: { id: subscription.id, title: subscription.title, url: subscription.url },
      range: requireDefinition(type).subscription!.checkRange(subscription.settings, at),
      excluded: new Set(subscription.excluded),
    };
  }

  async checked(type: string, id: string, report: CheckReport): Promise<SkipReason | null> {
    if (this.hangOnChecked) {
      this.hangOnChecked = false;
      await never();
    }
    this.reports.push({
      kind: 'checked', type, id, at: report.at,
      ...(report.candidates ? { candidates: [...report.candidates] } : {}),
      ...(report.collecting ? { collecting: [...report.collecting] } : {}),
    });
    return this.stopped(type, id);
  }

  async itemCollected(type: string, id: string, itemKey: string): Promise<void> {
    this.reports.push({ kind: 'collected', type, id, key: itemKey });
  }

  async itemFailed(type: string, id: string, item: { key: string; title: string | null; url: string }, error: JobError, failureClass: FailureClass): Promise<ItemFailureEntry | null> {
    this.reports.push({ kind: 'failed', type, id, key: item.key, title: item.title, errorCode: error.code, failureClass });
    if (!this.get(type, id)) return null;
    const attempts = (this.failures.get(item.key) ?? 0) + 1;
    this.failures.set(item.key, attempts);
    return { title: item.title ?? '', attempts, errorCode: error.code, failedAt: new Date(0).toISOString(), skipped: failureClass === 'skip' || attempts >= 3 };
  }

  async itemOutOfRange(type: string, id: string, itemKey: string, before: string): Promise<void> {
    this.reports.push({ kind: 'outOfRange', type, id, key: itemKey, before });
  }

  async subscribe(type: string, target: SubscriptionTarget, settings: SubscriptionSettings, options: { resumed: boolean; beforeCreate: () => Promise<void> }): Promise<SubscribeResult> {
    const existing = this.get(type, target.id);
    if (existing && !options.resumed) {
      this.reports.push({ kind: 'subscribed', type, id: target.id, outcome: 'existing', resumed: false });
      return { subscription: existing, outcome: 'existing', check: null };
    }
    let subscription = existing;
    if (!subscription) {
      await options.beforeCreate();
      subscription = this.add(type, target, { settings });
      if (this.hangAfterSubscribe) {
        this.hangAfterSubscribe = false;
        await never();
      }
    }
    this.reports.push({ kind: 'subscribed', type, id: target.id, outcome: 'created', resumed: options.resumed });
    return { subscription, outcome: 'created', check: await this.requireJobs().submitCheck(type, subscription, 'subscribe') };
  }

  async stopped(type: string, id: string): Promise<SkipReason | null> {
    const subscription = this.get(type, id);
    if (!subscription) return 'subscription_removed';
    return subscription.enabled ? null : 'subscription_paused';
  }

  async checkNow(type: string, id: string): Promise<JobSubmission> {
    this.reports.push({ kind: 'checkNow', type, id });
    const subscription = this.get(type, id);
    if (!subscription) throw new Error(`No subscription ${type}:${id}`);
    return this.requireJobs().submitCheck(type, subscription, 'manual');
  }

  private requireJobs(): JobManager {
    if (!this.jobs) throw new Error('SubscriptionRecorder is not attached to a job manager');
    return this.jobs;
  }
}

function key(type: string, id: string): string {
  return `${type}:${id}`;
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

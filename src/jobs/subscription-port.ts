import type { FailureClass, CheckRange, SubscriptionTarget } from '../plugins/types.js';
import type { ItemFailureEntry, JobError, JobSubmission, SkipReason, SubscriptionSettings } from '../core/types.js';

/** What a check of one subscription discovers with, read when its discovery starts. */
export interface CheckPlan {
  /** The subscription as its source lists it. */
  target: SubscriptionTarget;
  range: CheckRange;
  /**
   * Keys of items that stay candidates without being collected: out of range for a range that
   * starts no earlier, or skipped after failing.
   */
  excluded: ReadonlySet<string>;
}

/** What a check found, reported once the item jobs it queued are recorded. */
export interface CheckReport {
  /** Keys of every candidate the listing gave, collected or not; absent when the check did not list. */
  candidates?: ReadonlySet<string>;
  /** Keys of the items the check collects. */
  collecting?: ReadonlySet<string>;
}

/**
 * How a check ended: with its items (`error` null), or failing. `counted` says whether the end
 * tells how the subscription's own listing went, so a success clears its failures in a row and a
 * failure adds one. It does not for a check a pause or removal stopped while its items finished, a
 * check the service gave up after repeated interruptions, or a source that needs a new sign-in.
 */
export interface CheckEnd {
  at: string;
  error: JobError | null;
  counted: boolean;
}

/** The subscription a request resolved to and the check that follows it. */
export interface SubscribeResult {
  subscription: SubscriptionTarget;
  /** `created` for a new subscription, `existing` for one already in the list, which keeps its own state. */
  outcome: 'created' | 'existing';
  /** The first check of a new subscription; null for an existing one. */
  check: JobSubmission | null;
}

/**
 * Everything a job needs from the subscriptions and everything it reports back to them. The job
 * manager owns queueing and running; the subscriptions own their records, dispatch times and
 * collection progress. Production wires it to the subscription services; tests use a recorder.
 */
export interface SubscriptionPort {
  /** The plan of a check whose discovery starts at `at`, or why the check stops instead. */
  planCheck(type: string, id: string, at: Date): Promise<CheckPlan | { stopped: SkipReason }>;
  /**
   * A check's discovery is recorded. Returns why the subscription's work stops when it was paused
   * or removed meanwhile, otherwise null.
   */
  checked(type: string, id: string, report: CheckReport): Promise<SkipReason | null>;
  /** A check ended: its items all ended, or the check itself failed. */
  checkEnded(type: string, id: string, end: CheckEnd): Promise<void>;
  /** A check's item was collected. */
  itemCollected(type: string, id: string, key: string): Promise<void>;
  /**
   * A check's item failed for good within its job. Returns the item's failure record after this
   * failure, or null when nothing was counted.
   */
  itemFailed(type: string, id: string, item: { key: string; title: string | null; url: string }, error: JobError, failureClass: FailureClass): Promise<ItemFailureEntry | null>;
  /** A check's item was published before the range start `before`. */
  itemOutOfRange(type: string, id: string, key: string, before: string): Promise<void>;
  /**
   * A subscription request resolved its address to `target`: subscribes it with `settings` and
   * dispatches its first check. `resumed` says the request was interrupted after it started
   * subscribing, so a subscription found under that ID is its own and still gets its first check.
   * `beforeCreate` runs before a new subscription is written.
   */
  subscribe(type: string, target: SubscriptionTarget, settings: SubscriptionSettings, options: { resumed: boolean; beforeCreate: () => Promise<void> }): Promise<SubscribeResult>;
  /** Null while the subscription exists and is enabled; otherwise why its work stops. */
  stopped(type: string, id: string): Promise<SkipReason | null>;
  /** Dispatches a check of the subscription now, as a manual check does. */
  checkNow(type: string, id: string): Promise<JobSubmission>;
}

/**
 * A port that forwards every call to the one `resolve` returns at call time, so a job manager can
 * be built before the subscriptions that hold it.
 */
export function forwardingPort(resolve: () => SubscriptionPort): SubscriptionPort {
  return {
    planCheck: (...args) => resolve().planCheck(...args),
    checked: (...args) => resolve().checked(...args),
    checkEnded: (...args) => resolve().checkEnded(...args),
    itemCollected: (...args) => resolve().itemCollected(...args),
    itemFailed: (...args) => resolve().itemFailed(...args),
    itemOutOfRange: (...args) => resolve().itemOutOfRange(...args),
    subscribe: (...args) => resolve().subscribe(...args),
    stopped: (...args) => resolve().stopped(...args),
    checkNow: (...args) => resolve().checkNow(...args),
  };
}

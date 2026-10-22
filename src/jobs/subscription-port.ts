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
  /** When the check's discovery started. */
  at: string;
  /** Keys of every candidate the listing gave, collected or not; absent when the check did not list. */
  candidates?: ReadonlySet<string>;
  /** Keys of the items the check collects. */
  collecting?: ReadonlySet<string>;
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
    itemCollected: (...args) => resolve().itemCollected(...args),
    itemFailed: (...args) => resolve().itemFailed(...args),
    itemOutOfRange: (...args) => resolve().itemOutOfRange(...args),
    subscribe: (...args) => resolve().subscribe(...args),
    stopped: (...args) => resolve().stopped(...args),
    checkNow: (...args) => resolve().checkNow(...args),
  };
}

import type { FailureClass, ListedItem, SubscriptionTarget } from '../../shared/sources/source-contract.js';
import type { ItemFailureEntry, SubscriptionSettings } from '../../shared/subscriptions/subscription-types.js';
import type { JobError, JobSubmission, SkipReason } from '../../shared/jobs/job-types.js';

export interface CandidateSelection {
  /** Keys of every candidate, collected or not, newest first. */
  candidates: string[];
  /** Items to collect, newest first. */
  items: ListedItem[];
  /** The start of the range; a capture skips an item whose exact publish time is earlier. */
  publishedNotBefore: string;
}

export interface CheckPlan {
  target: SubscriptionTarget;
  /**
   * `listing` yields newest first; read it only as far as the check needs. `hasDocument` is true for
   * an item collected or deleted in the Vault.
   */
  select(listing: AsyncIterable<ListedItem>, hasDocument: (key: string) => Promise<boolean>): Promise<CandidateSelection>;
}

/** Reported once the item jobs the check queued are recorded. */
export interface CheckReport {
  /** Keys of every candidate the listing gave, collected or not. */
  candidates: ReadonlySet<string>;
  collecting: ReadonlySet<string>;
}

/**
 * `error` is null when the check ended with its items. `counted` is false when the job's own work
 * says nothing about the subscription's listing: a check a pause or removal stopped while its items
 * finished, or a check the service gave up after repeated interruptions.
 */
export interface CheckEnd {
  at: string;
  error: JobError | null;
  /** How the source type treats `error`; null for a check that ended with its items. */
  failureClass: FailureClass | null;
  counted: boolean;
}

export type SubscribeResult =
  | { subscription: SubscriptionTarget; outcome: 'created'; check: JobSubmission }
  | { subscription: SubscriptionTarget; outcome: 'existing'; check: null };

export interface SubscriptionPort {
  planCheck(type: string, id: string, at: Date): Promise<CheckPlan | { stopped: SkipReason }>;
  /** Returns why the subscription's work stops when it was paused or removed meanwhile, otherwise null. */
  checked(type: string, id: string, report: CheckReport): Promise<SkipReason | null>;
  checkEnded(type: string, id: string, end: CheckEnd): Promise<void>;
  itemCollected(type: string, id: string, key: string): Promise<void>;
  /**
   * The item failed for good within its job. Returns the item's failure record after this failure,
   * or null when nothing was counted.
   */
  itemFailed(type: string, id: string, item: { key: string; title: string | null; url: string }, error: JobError, failureClass: FailureClass): Promise<ItemFailureEntry | null>;
  itemOutOfRange(type: string, id: string, key: string, before: string): Promise<void>;
  /**
   * Subscribes `target` with `settings` and dispatches its first check; a subscription already in
   * the list keeps its own state.
   */
  subscribe(type: string, target: SubscriptionTarget, settings: SubscriptionSettings): Promise<SubscribeResult>;
  /** Null while the subscription exists and is enabled; otherwise why its work stops. */
  stopped(type: string, id: string): Promise<SkipReason | null>;
  checkNow(type: string, id: string): Promise<JobSubmission>;
}

/** Forwards every call to the port `resolve` returns at call time. */
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

/**
 * What opening, exporting and importing a Vault need from its subscription and schedule files. The
 * subscriptions block owns the files' format and the rules for merging two copies of a
 * subscription, and implements this contract; the Vault reaches the files only through it. The
 * assembly registers the implementation before anything reads a Vault (`src/plugins/index.ts`).
 *
 * Every `value` is a file's parsed JSON, or undefined when the Vault has no such file.
 */

/** The subscriptions and removal records of one source type's file, as an import compares them. */
export interface ExchangedSubscriptions {
  /**
   * The subscriptions: what a person set on each, as text that is equal exactly when the settings
   * are, and when the person last set it.
   */
  subscriptions: Array<{ id: string; content: string; at: string }>;
  /** The removal records, with the time of each removal. */
  removals: Array<{ id: string; at: string }>;
}

/** The subscriptions file of one source type. */
export interface SubscriptionFileExchange {
  readonly type: string;
  /** The file, relative to the Vault root. */
  readonly file: string;
  /** Reads a file; throws when it is no file of the current version. */
  read(value: unknown): ExchangedSubscriptions;
  /**
   * The file `local` with the subscriptions and removal records of `ids` taken from `incoming`: a
   * subscription `incoming` holds arrives merged with the local copy, one it lacks leaves, and a
   * removal record follows the same way. The other top-level fields of `local` stay.
   */
  take(local: unknown, incoming: unknown, ids: readonly string[]): Record<string, unknown>;
}

export interface SubscriptionExchange {
  /** One per registered source type with subscriptions, in registration order. */
  files(): SubscriptionFileExchange[];
  /** Throws when a schedule file is no file of the current version. */
  checkSchedule(value: unknown): void;
}

let registered: SubscriptionExchange | null = null;

export function registerSubscriptionExchange(exchange: SubscriptionExchange): void {
  registered = exchange;
}

export function subscriptionExchange(): SubscriptionExchange {
  if (!registered) throw new Error('No subscription exchange is registered');
  return registered;
}

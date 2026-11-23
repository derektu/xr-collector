export interface ExchangedSubscriptions {
  /**
   * The subscriptions: what a person set on each, as text that is equal exactly when the settings
   * are, and when the person last set it.
   */
  subscriptions: Array<{ id: string; content: string; at: string }>;
  removals: Array<{ id: string; at: string }>;
}

/** Every `value`, `local` and `incoming` is a file's parsed JSON, or undefined when the Vault has no such file. */
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
  /** One per source type of the registry with subscriptions, in its order. */
  files(): SubscriptionFileExchange[];
  /** Throws when a schedule file is no file of the current version; `value` is undefined when the Vault has no schedule file. */
  checkSchedule(value: unknown): void;
}

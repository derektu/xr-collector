import type {
  DocumentMetadata,
  JobPhase,
  SourceTypeInfo,
  SubscriptionSettings,
} from '../core/types.js';

/**
 * The contract between the type-agnostic core and one source type. A source plugin owns everything
 * that depends on where content comes from: which addresses it accepts, how an item is captured,
 * how a subscription lists its items, which failures are worth retrying, its request pacing, its
 * subscription settings, the type-specific frontmatter of its documents and its words for the UI.
 * The core owns jobs, subscriptions, the Vault, search, activity and exchange, and reaches a
 * source only through this contract.
 *
 * The declaration part is pure data and functions, so the web UI imports it as well
 * (`src/plugins/<type>/shared.ts`); the server part adds network and file access
 * (`src/plugins/<type>/server.ts`).
 */

/** One collectable item: its key within the source type, its canonical address and its title once known. */
export interface ItemRef {
  key: string;
  url: string;
  title: string | null;
}

/** What a subscription follows, such as a channel or a feed, once the source has resolved its address. */
export interface SubscriptionTarget {
  id: string;
  title: string;
  url: string;
}

/** One item of a subscription's listing. */
export interface ListedItem extends ItemRef {
  /** Publish time as the listing reports it, possibly approximate; null when the listing has none. */
  publishedAt: string | null;
  /** False for an item that cannot be collected yet, such as a scheduled premiere; a check passes over it. */
  eligible: boolean;
}

/** A captured item, ready to be saved as a document of its source type. */
export interface CapturedItem {
  key: string;
  sourceUrl: string;
  title: string;
  /** Who published the item; `id` is null when the source reports no stable publisher ID. */
  publisher: { id: string | null; name: string };
  publishedAt: string | null;
  bodyMarkdown: string;
  /** The type-specific details the document carries under a field named after its source type. */
  details: Record<string, unknown> | null;
}

/** A captured item together with its source type: what the core saves. */
export interface CapturedDocument extends CapturedItem {
  sourceType: string;
}

/**
 * How the core treats a failed capture or listing. `retry_now`: a transient failure, retried
 * automatically while attempts remain. `rate_limited`: the source limited requests; the job waits
 * for the pacing group's cooldown without spending an attempt. `retry_next_check`: the item stays a
 * candidate that the next check of its subscription tries again. `skip`: the item cannot be
 * collected. `login_required`: the source needs the user to sign in again.
 */
export type FailureClass = 'retry_now' | 'retry_next_check' | 'skip' | 'login_required' | 'rate_limited';

/** How a source request runs. */
export interface RequestContext {
  /** Aborting it before a request starts leaves that request out; a running request finishes. */
  signal?: AbortSignal;
  /** `interactive` marks a request the user is waiting for; it goes before queued background work. */
  priority?: 'interactive' | 'background';
  /** A capture skips an item published earlier than this time with `out_of_range`, before downloading its content. */
  publishedNotBefore?: string;
}

/** What a pasted address asks for: one item, or a subscription to the address it normalizes to. */
export type InputClass =
  | { kind: 'item'; ref: ItemRef }
  | { kind: 'subscription'; url: string };

/** The part of a subscription's listing one check collects from. */
export interface CheckRange {
  /** Items published before this time are outside the range. */
  since: Date;
  /** The newest items within the range that are candidates. */
  maxItems: number;
}

/** The item a source type collects and how its documents look. */
export interface ItemDeclaration {
  /** What one item is called, e.g. "影片". */
  noun: string;
  /** The measure word that counts items, e.g. "支" in "3 支影片". */
  measure: string;
  /** The keys an item of this type may have; a document file or ID with any other key is not a document. */
  keyPattern: RegExp;
  /** The frontmatter `type` of the type's documents. */
  documentType: string;
  /** The canonical address of an item. */
  urlForKey(key: string): string;
  /** The reader's link to the item at its source. */
  openOriginalLabel: string;
}

/** What a subscription of a source type follows and the settings it collects with. */
export interface SubscriptionDeclaration<S extends SubscriptionSettings = SubscriptionSettings> {
  /** What a subscription follows, e.g. "頻道". */
  targetNoun: string;
  /** The settings a new subscription starts with. */
  defaults: S;
  /** Whether a stored value is a complete, valid set of settings. */
  isValidSettings(value: unknown): boolean;
  /**
   * Reads settings from a request: an object with any of the settings and nothing else. Throws
   * `invalid_request` for other keys or values, and for an empty object unless `allowEmpty`.
   */
  parseSettingsPatch(value: unknown, options?: { allowEmpty?: boolean }): Partial<S>;
  /** The range a subscription's settings collect, in words. */
  describeSettings(settings: S): string;
  /** The range one check starting at `now` collects. */
  checkRange(settings: S, now: Date): CheckRange;
  /**
   * The settings form's "every check" row: words and the setting fields between them, in reading
   * order. Without it, the form shows each range field with its own label.
   */
  sentence?: Array<string | { field: string }>;
}

/** Input hints the HTTP API and the UI give for an empty or unusable address of this type. */
export interface InputPrompts {
  /** Any address the type accepts. */
  anyInput: string;
  /** A single item's address. */
  itemInput: string;
  /** A subscription's address. */
  subscriptionInput: string;
  /** The hint in an empty address field of the dialog that adds one item. */
  itemPlaceholder: string;
  /** The hint in an empty address field of the dialog that subscribes. */
  subscriptionPlaceholder: string;
  /** What collecting a recognized single item does, on its confirmation card. */
  itemCard: string;
}

/**
 * Names of the type's job kinds. The wire kind of a job is `<type>.<name>`: `item` collects one
 * item, `check` lists a subscription and collects what it found, `add` resolves an address and
 * subscribes to it.
 */
export interface JobKindNames {
  item: string;
  check?: string;
  add?: string;
}

/**
 * The pure part of a source plugin: what the UI, the HTTP API and the core read without contacting
 * the source.
 */
export interface SourcePluginDeclaration<S extends SubscriptionSettings = SubscriptionSettings> extends SourceTypeInfo {
  item: ItemDeclaration;
  subscription?: SubscriptionDeclaration<S>;
  jobKindNames: JobKindNames;
  /** Labels of job phases that differ from the core's own, such as the source's word for `capture`. */
  phaseLabels?: Partial<Record<JobPhase, string>>;
  /** A line of type-specific details the reader shows under a document's title; null shows nothing. */
  documentDetailLine?(document: DocumentMetadata): string | null;
  prompts: InputPrompts;
  /** Whether the input belongs to this type; decided by syntax alone. */
  owns(input: string, url: URL | null): boolean;
  /** What an owned address asks for; throws `invalid_url` or `unsupported_url` with the reason. */
  classify(input: string): InputClass;
  /** A single item's address as an item; throws `invalid_url` with the reason when it is not one. */
  parseItem(url: string): ItemRef;
}

/** How the requests of a pacing group are spaced and cooled down. */
export interface PacingDeclaration {
  /** Requests of every plugin with the same group share one request channel and its cooldowns. */
  group: string;
  /** The source's name in cooldown messages. */
  label: string;
  /** Random gap between two requests, in milliseconds. */
  waitRangeMs: { min: number; max: number };
  cooldown?: { initialMs?: number; maxMs?: number; resetAfterMs?: number };
  /** Environment variable that overrides `waitRangeMs` as `min,max`, for tests and acceptance runs. */
  envVar?: string;
}

/** Where a type's subscriptions live in the Vault. */
export interface SubscriptionStorage {
  /** The subscriptions file, relative to the Vault root. */
  subscriptionsFile: string;
  /** The file version this program reads and writes. */
  version: number;
  /** The top-level key of the subscription list. */
  listKey: string;
  /** The field of an out-of-range entry that holds the item key. */
  outOfRangeKeyField: string;
  /** How diagnostics name the file's records, e.g. "Invalid <description> settings". */
  description: string;
}

/** The type-specific part of a document's frontmatter, under its `collector` block. */
export interface FrontmatterCodec {
  /** The fields to add after the core's own; their order is the order in the file. */
  write(details: Record<string, unknown> | null): Record<string, unknown>;
  /** The details a document carries, read from its `collector` block; throws when the fields are invalid. */
  read(collector: Record<string, unknown>): Record<string, unknown> | null;
}

/** The static server part of a plugin: everything except the operations that contact the source. */
export interface SourceDefinition<S extends SubscriptionSettings = SubscriptionSettings> extends SourcePluginDeclaration<S> {
  /** How the core treats a failure with this error code. */
  classifyFailure(error: { code: string }): FailureClass;
  pacing: PacingDeclaration | null;
  /** Null for a type without subscriptions. */
  storage: SubscriptionStorage | null;
  frontmatter: FrontmatterCodec;
  /**
   * The lowest Vault format version that holds this type's documents and subscription file. The
   * first write of either raises the Vault's marker to it; a Vault whose version is higher than
   * every registered type declares is not opened.
   */
  vaultFormatVersion: number;
  /**
   * The export package format version a package holding this type's files needs. A package is
   * written with the highest version among the types whose files it holds.
   */
  packageFormatVersion: number;
  /**
   * The HTTP status of each error code this type raises beyond the core's own codes; the server
   * answers an error with such a code with this status.
   */
  errorStatus?: Readonly<Record<string, number>>;
}

/** Whether a source needs the user to sign in again. */
export interface SourceLogin {
  status(): 'signed_in' | 'required';
  /** What signing in means for this source, in words. */
  describe(): string;
}

/** A source plugin as the composition root builds it: the definition and the operations that contact the source. */
export interface SourcePlugin<S extends SubscriptionSettings = SubscriptionSettings> extends SourceDefinition<S> {
  captureItem(ref: ItemRef, context: RequestContext): Promise<CapturedItem>;
  /** Resolves a subscription address; types with subscriptions provide it. */
  resolveTarget?(url: string, context: RequestContext): Promise<SubscriptionTarget>;
  /** The target's items, newest first; the core stops reading once it has what one check needs. */
  listSubscriptionItems?(target: SubscriptionTarget, context: RequestContext): AsyncIterable<ListedItem>;
  login?: SourceLogin;
}

/** A request channel: runs each request in its turn, `interactive` ones before queued `background` ones. */
export interface RequestChannel {
  run<T>(priority: 'interactive' | 'background', request: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** What a composition root lends a plugin factory: external programs, request channels and the environment. */
export interface PluginRuntime {
  /** Device profile folder. */
  profilePath: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The path of an external program, by its file name without extension and the environment variable that may name it instead. */
  program(name: string, environmentName: string): string;
  /** This device's request channel of a pacing group the plugin declares. */
  gate(group: string): RequestChannel;
}

/** One source type of the product: its definition, registered before any Vault opens, and the factory of its plugin. */
export interface SourceEntry {
  definition: SourceDefinition;
  create(runtime: PluginRuntime): SourcePlugin;
}

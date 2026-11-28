import type { ContentExtent, DocumentMetadata } from '../documents/document-types.js';
import type { SourceTypeInfo } from './source-info-types.js';
import type { SourceSettings, SubscriptionSettings } from '../subscriptions/subscription-types.js';

/** `key` is unique within its source type; `url` is the item's canonical address; `title` is null until the source reports it. */
export interface ItemRef {
  key: string;
  url: string;
  title: string | null;
}

export interface SubscriptionTarget {
  id: string;
  title: string;
  url: string;
}

export interface ListedItem extends ItemRef {
  /** Publish time as the listing reports it, possibly approximate; null when the listing has none. */
  publishedAt: string | null;
  /** False for an item that cannot be collected yet, such as a scheduled premiere; a check passes over it. */
  eligible: boolean;
}

export interface CapturedItem {
  key: string;
  sourceUrl: string;
  title: string;
  /** `id` is null when the source reports no stable publisher ID. */
  publisher: { id: string | null; name: string };
  publishedAt: string | null;
  bodyMarkdown: string;
  contentExtent: ContentExtent;
  details: Record<string, unknown> | null;
}

export interface CapturedDocument extends CapturedItem {
  sourceType: string;
}

export type FailureClass = 'retry_now' | 'retry_next_check' | 'skip' | 'login_required' | 'rate_limited';

export interface RequestContext {
  /** Aborting it before a request starts leaves that request out. */
  signal?: AbortSignal;
  priority?: 'interactive' | 'background';
  /** A capture skips an item published earlier than this time with `out_of_range`, before downloading its content. */
  publishedNotBefore?: string;
  /** For a capture of an item a subscription check found: that subscription's target. */
  subscription?: SubscriptionTarget;
}

export type InputClass =
  | { kind: 'item'; ref: ItemRef }
  | { kind: 'subscription'; url: string };

export interface CheckRange {
  since: Date;
  maxItems: number;
}

export interface ItemDeclaration {
  noun: string;
  measureWord: string;
  /** The keys an item of this type may have; a document file or ID with any other key is not a document. */
  keyPattern: RegExp;
  documentType: string;
  /**
   * The canonical address of an item, for a type whose keys determine it. Without it, an item's
   * address is known only from the listing or capture that reported it.
   */
  urlForKey?(key: string): string;
  openOriginalLabel: string;
}

export interface SubscriptionDeclaration<S extends SourceSettings = SourceSettings> {
  targetNoun: string;
  defaults: S;
  /** Whether a stored value is a complete, valid set of settings. */
  isValidSettings(value: unknown): boolean;
  /**
   * Reads settings from a request: an object with any of the settings and nothing else. Throws
   * `invalid_request` for other keys or values, and for an empty object unless `allowEmpty`.
   */
  parseSettingsPatch(value: unknown, options?: { allowEmpty?: boolean }): Partial<S>;
  describeSettings(settings: S): string;
  checkRange(settings: S, now: Date): CheckRange;
  /**
   * The settings form's "every check" row: words and the setting fields between them, in reading
   * order. Without it, the form shows each range field with its own label.
   */
  sentence?: Array<string | { field: string }>;
}

/** Input hints the HTTP API and the UI give for an empty or unusable address of this type. */
export interface InputPrompts {
  anyInputHint: string;
  itemInputHint: string;
  subscriptionInputHint: string;
  itemPlaceholder: string;
  subscriptionPlaceholder: string;
  itemCardText: string;
}

export interface JobKindNames {
  item: string;
  check?: string;
  add?: string;
}

export interface SourcePluginDeclaration<S extends SourceSettings = SourceSettings> extends SourceTypeInfo {
  item: ItemDeclaration;
  subscription?: SubscriptionDeclaration<S>;
  jobKindNames: JobKindNames;
  failureLabels?: Readonly<Record<string, string>>;
  /** A line of type-specific details the reader shows under a document's title; null shows nothing. */
  documentDetailLine?(document: DocumentMetadata): string | null;
  prompts: InputPrompts;
  /** Whether the input belongs to this type, decided by syntax alone. */
  owns(input: string, url: URL | null): boolean;
  /** What an owned address asks for; throws `invalid_url` or `unsupported_url` with the reason. */
  classify(input: string): InputClass;
  /** A single item's address as an item; throws `invalid_url` with the reason when it is not one. */
  parseItem(url: string): ItemRef;
}

export interface PacingDeclaration {
  group: string;
  /** The source's name in cooldown messages. */
  label: string;
  waitRangeMs: { min: number; max: number };
  cooldown?: { initialMs?: number; maxMs?: number; resetAfterMs?: number } | false;
  /** Environment variable that overrides `waitRangeMs`, written `min,max`. */
  envVar?: string;
}

export interface SubscriptionStorage {
  /** The subscriptions file, relative to the Vault root. */
  subscriptionsFile: string;
  /** The file version this program reads and writes. */
  version: number;
  listKey: string;
  /** The field of an out-of-range entry that holds the item key. */
  outOfRangeKeyField: string;
  /** How diagnostics name the file's records, e.g. "Invalid <description> settings". */
  description: string;
}

export interface FrontmatterCodec {
  /** The fields to add after the core's own; their order is the order in the file. */
  write(details: Record<string, unknown> | null): Record<string, unknown>;
  /** The details a document carries, read from its `collector` block; throws when the fields are invalid. */
  read(collector: Record<string, unknown>): Record<string, unknown> | null;
}

export interface SourceDefinition<S extends SourceSettings = SourceSettings> extends SourcePluginDeclaration<S> {
  classifyFailure(error: { code: string }): FailureClass;
  pacing: PacingDeclaration | null;
  storage: SubscriptionStorage | null;
  frontmatter: FrontmatterCodec;
  errorStatus?: Readonly<Record<string, number>>;
}

export interface SourceLogin {
  status(): 'signed_in' | 'required';
}

export interface SourcePlugin<S extends SourceSettings = SourceSettings> extends SourceDefinition<S> {
  captureItem(ref: ItemRef, context: RequestContext): Promise<CapturedItem>;
  resolveTarget?(url: string, context: RequestContext): Promise<SubscriptionTarget>;
  /** The target's items, newest first; the core stops reading once it has what one check needs. */
  listSubscriptionItems?(target: SubscriptionTarget, context: RequestContext): AsyncIterable<ListedItem>;
  login?: SourceLogin;
}

export interface RequestChannel {
  run<T>(priority: 'interactive' | 'background', request: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface PluginRuntime {
  profilePath: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The path of an external program, by its path under the runtime folder without extension (`tool`, or `tool/tool` for a program that ships in its own folder) and the environment variable that may name it instead. */
  program(name: string, environmentName: string): string;
  /** This device's request channel of a pacing group the plugin declares. */
  gate(group: string): RequestChannel;
}

export interface SourceEntry {
  definition: SourceDefinition;
  create(runtime: PluginRuntime): SourcePlugin;
}

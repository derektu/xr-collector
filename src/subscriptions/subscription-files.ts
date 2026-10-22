import { scheduleFileDescription } from '../core/source-registry.js';
import type { ItemFailureEntry, SubscriptionRecord } from '../core/types.js';
import type { SourceDefinition } from '../plugins/types.js';

/**
 * Vault files of subscriptions, relative to the Vault root. Each source type with subscriptions has
 * its own file, named by its storage declaration:
 * `{ version: <version>, <list key>: [...], removed: [...] }`. Every subscription carries its own
 * settings and check times, and every removed subscription leaves a record
 * `{ id, title, url, removedAt }` that stays until the target is subscribed again, so an import
 * from another machine that still has the subscription does not bring it back. A file without
 * `removed` has no records.
 *
 * A subscription's collection progress, `outOfRange` and `failures`, lives in its record next to its
 * settings; both key items by the field the storage declaration names.
 *
 * The schedule file the assembly names is `{ version: 2, enabled }`, the automatic collection
 * switch of every type. Fields a subscription or file does not define are kept as they are, so a
 * file written by a newer program, or one with fields no longer in use, reads and saves without
 * losing them. Files of any other version are not read.
 */

/** What reading a type's subscriptions file needs from its definition. */
export type SubscriptionFileSpec = Pick<SourceDefinition, 'storage' | 'subscription'>;

/** A removed subscription: when it was removed, and its name and address for people reading the record. */
export interface SubscriptionRemoval { id: string; title: string; url: string; removedAt: string }
export interface ScheduleFile { version: 2; enabled: boolean }

export class InvalidSubscriptionFile extends Error {}

function storageOf(spec: SubscriptionFileSpec) {
  if (!spec.storage || !spec.subscription) throw new Error('The source type has no subscriptions');
  return { storage: spec.storage, subscription: spec.subscription };
}

/** The subscriptions of a type's file; a Vault without one has none. */
export function subscriptionsFromJson(spec: SubscriptionFileSpec, value: unknown): SubscriptionRecord[] {
  if (value === undefined) return [];
  const { storage, subscription } = storageOf(spec);
  const file = value as Record<string, unknown> | null;
  const list = file && typeof file === 'object' ? file[storage.listKey] : undefined;
  if (!file || typeof file !== 'object' || file.version !== storage.version || !Array.isArray(list)
    || !list.every((entry) => isRecord(entry, storage.outOfRangeKeyField, subscription.isValidSettings))) {
    throw new InvalidSubscriptionFile(`Invalid ${storage.description} settings`);
  }
  return list as SubscriptionRecord[];
}

/** The removal records of a type's file; a Vault without one, or a file without `removed`, has none. */
export function removalsFromJson(spec: SubscriptionFileSpec, value: unknown): SubscriptionRemoval[] {
  subscriptionsFromJson(spec, value);
  const removed = (value as { removed?: unknown } | undefined)?.removed;
  if (removed === undefined) return [];
  if (!Array.isArray(removed) || !removed.every(isRemoval)) {
    throw new InvalidSubscriptionFile(`Invalid ${storageOf(spec).storage.description} settings`);
  }
  return removed;
}

/** A type's file as written: the other top-level fields of `current` kept, the list and the records replaced. */
export function subscriptionsToJson(
  spec: SubscriptionFileSpec, current: unknown, subscriptions: SubscriptionRecord[], removed?: SubscriptionRemoval[],
): Record<string, unknown> {
  const { storage } = storageOf(spec);
  const top = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...top, version: storage.version, [storage.listKey]: subscriptions };
  if (removed !== undefined) {
    if (removed.length) next.removed = removed;
    else delete next.removed;
  }
  return next;
}

function isRemoval(value: unknown): value is SubscriptionRemoval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<SubscriptionRemoval>;
  return typeof record.id === 'string' && typeof record.title === 'string' && typeof record.url === 'string'
    && typeof record.removedAt === 'string' && !Number.isNaN(Date.parse(record.removedAt));
}

/** The automatic collection switch of a schedule file; a Vault without one collects automatically. */
export function scheduleEnabledFromJson(value: unknown): boolean {
  if (value === undefined) return true;
  const file = value as { version?: unknown; enabled?: unknown } | null;
  if (!file || typeof file !== 'object' || file.version !== 2 || typeof file.enabled !== 'boolean') {
    throw new InvalidSubscriptionFile(`Invalid ${scheduleFileDescription()} settings`);
  }
  return file.enabled;
}

function isRecord(value: unknown, keyField: string, isValidSettings: (value: unknown) => boolean): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<SubscriptionRecord>;
  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && typeof record.url === 'string'
    && typeof record.enabled === 'boolean'
    && typeof record.addedAt === 'string'
    && isOptionalTime(record.updatedAt)
    && isOptionalTime(record.lastCheckedAt)
    && isValidSettings(record.settings) && isOptionalTime(record.nextCheckAt) && isOptionalTime(record.lastDispatchedAt)
    && (record.outOfRange === undefined || (Array.isArray(record.outOfRange)
      && record.outOfRange.every((entry) => typeof entry?.[keyField] === 'string' && typeof entry.before === 'string')))
    && (record.failures === undefined || (Array.isArray(record.failures) && record.failures.every((entry) => isFailure(entry, keyField))));
}

function isFailure(value: unknown, keyField: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<ItemFailureEntry>;
  return typeof entry[keyField] === 'string' && typeof entry.title === 'string'
    && typeof entry.attempts === 'number' && Number.isInteger(entry.attempts) && entry.attempts >= 1
    && typeof entry.errorCode === 'string' && typeof entry.failedAt === 'string' && typeof entry.skipped === 'boolean'
    && (entry.url === undefined || typeof entry.url === 'string');
}

function isOptionalTime(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/** JSON with object keys in sorted order, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * What a person sets on a subscription: its title, URL, paused state and settings. Collection
 * progress, check times and fields the program does not use are left out, so they never count as a
 * change of the subscription.
 */
export function subscriptionContent({ title, url, enabled, settings }: SubscriptionRecord): string {
  return canonicalJson({ title, url, enabled, settings });
}

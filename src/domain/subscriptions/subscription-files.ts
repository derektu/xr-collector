import type { CheckFailures, ItemFailureEntry, SubscriptionRecord } from '../../shared/subscriptions/subscription-types.js';
import type { SourceDefinition } from '../../shared/sources/source-contract.js';


export type SubscriptionFileSpec = Pick<SourceDefinition, 'storage' | 'subscription'>;

export interface SubscriptionRemoval { id: string; title: string; url: string; removedAt: string }
export interface ScheduleFile { version: 2; enabled: boolean }

export class InvalidSubscriptionFile extends Error {}

function storageOf(spec: SubscriptionFileSpec) {
  if (!spec.storage || !spec.subscription) throw new Error('The source type has no subscriptions');
  return { storage: spec.storage, subscription: spec.subscription };
}

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

export function removalsFromJson(spec: SubscriptionFileSpec, value: unknown): SubscriptionRemoval[] {
  subscriptionsFromJson(spec, value);
  const removed = (value as { removed?: unknown } | undefined)?.removed;
  if (removed === undefined) return [];
  if (!Array.isArray(removed) || !removed.every(isRemoval)) {
    throw new InvalidSubscriptionFile(`Invalid ${storageOf(spec).storage.description} settings`);
  }
  return removed;
}

export function subscriptionsToJson(
  spec: SubscriptionFileSpec, current: unknown, subscriptions: SubscriptionRecord[], removed?: SubscriptionRemoval[],
): Record<string, unknown> {
  const { storage } = storageOf(spec);
  const top = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  const { removed: kept, ...rest } = top;
  const next: Record<string, unknown> = { ...rest, version: storage.version, [storage.listKey]: subscriptions };
  const removals = removed === undefined ? kept : removed.length > 0 ? removed : undefined;
  if (removals !== undefined) next.removed = removals;
  return next;
}

function isRemoval(value: unknown): value is SubscriptionRemoval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<SubscriptionRemoval>;
  return typeof record.id === 'string' && typeof record.title === 'string' && typeof record.url === 'string'
    && typeof record.removedAt === 'string' && !Number.isNaN(Date.parse(record.removedAt));
}

export function scheduleEnabledFromJson(value: unknown, description: string): boolean {
  if (value === undefined) return true;
  const file = value as { version?: unknown; enabled?: unknown } | null;
  if (!file || typeof file !== 'object' || file.version !== 2 || typeof file.enabled !== 'boolean') {
    throw new InvalidSubscriptionFile(`Invalid ${description} settings`);
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
    && (record.checkFailures === undefined || isCheckFailures(record.checkFailures))
    && (record.autoPausedAt === undefined || typeof record.autoPausedAt === 'string')
    && isValidSettings(record.settings) && isOptionalTime(record.nextCheckAt) && isOptionalTime(record.lastDispatchedAt)
    && (record.outOfRange === undefined || (Array.isArray(record.outOfRange)
      && record.outOfRange.every((entry) => typeof entry?.[keyField] === 'string' && typeof entry.before === 'string')))
    && (record.failures === undefined || (Array.isArray(record.failures) && record.failures.every((entry) => isFailure(entry, keyField))));
}

function isCheckFailures(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const failures = value as Partial<CheckFailures>;
  return typeof failures.count === 'number' && Number.isInteger(failures.count) && failures.count >= 1
    && typeof failures.since === 'string'
    && typeof failures.error?.code === 'string' && typeof failures.error.message === 'string';
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

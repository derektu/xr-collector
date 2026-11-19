import { canonicalJson } from '../../shared/lib/canonical-json.js';
import type { SubscriptionRecord } from '../../shared/subscriptions/subscription-types.js';

export const SUBSCRIPTION_FIELDS = {
  id: 'identity',
  addedAt: 'identity',
  title: 'person',
  url: 'person',
  enabled: 'person',
  settings: 'person',
  updatedAt: 'person',
  lastCheckedAt: 'progress',
  checkFailures: 'progress',
  outOfRange: 'progress',
  failures: 'progress',
  nextCheckAt: 'schedule',
  lastDispatchedAt: 'schedule',
  autoPausedAt: 'schedule',
} as const satisfies Record<keyof SubscriptionRecord, 'identity' | 'person' | 'progress' | 'schedule'>;

type FieldPart = (typeof SUBSCRIPTION_FIELDS)[keyof SubscriptionRecord];
type FieldsOf<P extends FieldPart> = { [K in keyof SubscriptionRecord]-?: (typeof SUBSCRIPTION_FIELDS)[K] extends P ? K : never }[keyof SubscriptionRecord];

const PERSON_TIME = 'updatedAt' satisfies FieldsOf<'person'>;

function fieldsOf(part: FieldPart): Array<keyof SubscriptionRecord> {
  return (Object.keys(SUBSCRIPTION_FIELDS) as Array<keyof SubscriptionRecord>).filter((field) => SUBSCRIPTION_FIELDS[field] === part);
}

const CONTENT_FIELDS = fieldsOf('person').filter((field) => field !== PERSON_TIME);
const LOCAL_FIELDS = [...fieldsOf('identity'), ...fieldsOf('progress')];

function pausedItself(record: SubscriptionRecord): boolean {
  return !record.enabled && record.autoPausedAt !== undefined;
}

function personValue<K extends keyof SubscriptionRecord>(record: SubscriptionRecord, field: K): SubscriptionRecord[K] {
  return (field === 'enabled' ? record.enabled || pausedItself(record) : record[field]) as SubscriptionRecord[K];
}

const IMPORTED_SCHEDULE: { [K in FieldsOf<'schedule'>]: (local: SubscriptionRecord | undefined, incoming: SubscriptionRecord) => SubscriptionRecord[K] } = {
  nextCheckAt: () => null,
  lastDispatchedAt: () => null,
  autoPausedAt: (local, incoming) => (local && pausedItself(local) && personValue(incoming, 'enabled') ? local.autoPausedAt : undefined),
};

export function subscriptionContent(record: SubscriptionRecord): string {
  return canonicalJson(Object.fromEntries(CONTENT_FIELDS.map((field) => [field, personValue(record, field)])));
}

export function importedSubscription(local: SubscriptionRecord | undefined, incoming: SubscriptionRecord): SubscriptionRecord {
  const merged: Record<string, unknown> = { ...incoming, enabled: personValue(incoming, 'enabled') };
  if (local) {
    for (const field of LOCAL_FIELDS) {
      if (local[field] === undefined) delete merged[field];
      else merged[field] = local[field];
    }
  } else if (pausedItself(incoming)) {
    delete merged.checkFailures;
  }
  for (const [field, rule] of Object.entries(IMPORTED_SCHEDULE)) {
    const value = rule(local, incoming);
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  if (merged.autoPausedAt !== undefined) merged.enabled = false;
  return merged as unknown as SubscriptionRecord;
}

import { canonicalJson } from '../core/canonical-json.js';
import type { SubscriptionRecord } from '../core/types.js';

/**
 * The part of a subscription each field of its record belongs to. What a change stamps, what an
 * import compares and what it takes from either machine all follow from this table, and the type
 * requires every field of `SubscriptionRecord` in it, so a new field cannot go unclassified.
 *
 * - `identity`: names the subscription and says when this Vault first had it; an import keeps the
 *   local value.
 * - `person`: what a person sets, and `updatedAt`, when they last set it. A change of any of them
 *   but `updatedAt` stamps `updatedAt` and counts as a change in an import, which takes the whole
 *   group from the side whose `updatedAt` is newer.
 * - `progress`: what this machine's checks found. An import keeps the local value of a subscription
 *   the Vault has, also when the local record lacks the field, because the other machine's progress
 *   describes checks this Vault never ran against its own documents.
 * - `schedule`: when the scheduler acts next; an import sets each from `IMPORTED_SCHEDULE`, taking
 *   neither side as it is.
 */
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

/** The person field that records when the others were set. */
const PERSON_TIME = 'updatedAt' satisfies FieldsOf<'person'>;

function fieldsOf(part: FieldPart): Array<keyof SubscriptionRecord> {
  return (Object.keys(SUBSCRIPTION_FIELDS) as Array<keyof SubscriptionRecord>).filter((field) => SUBSCRIPTION_FIELDS[field] === part);
}

const CONTENT_FIELDS = fieldsOf('person').filter((field) => field !== PERSON_TIME);
const LOCAL_FIELDS = [...fieldsOf('identity'), ...fieldsOf('progress')];

/**
 * The schedule fields of a subscription an import writes, from the merged record. The next check
 * and the last submission start over, so the scheduler plans the subscription one interval after
 * the import. A subscription paused itself only while it is paused and has the failures that paused
 * it, so the time of such a pause stays only with both.
 */
const IMPORTED_SCHEDULE: { [K in FieldsOf<'schedule'>]: (merged: SubscriptionRecord) => SubscriptionRecord[K] } = {
  nextCheckAt: () => null,
  lastDispatchedAt: () => null,
  autoPausedAt: (merged) => (merged.enabled || !merged.checkFailures ? undefined : merged.autoPausedAt),
};

/**
 * What a person sets on a subscription, as text that is equal exactly when those fields are:
 * the `person` fields other than `updatedAt`. Collection progress, check times and fields the
 * program does not use are left out, so they never count as a change of the subscription.
 */
export function subscriptionContent(record: SubscriptionRecord): string {
  return canonicalJson(Object.fromEntries(CONTENT_FIELDS.map((field) => [field, record[field]])));
}

/**
 * The subscription an import writes when it takes `incoming` from the other machine: its `person`
 * fields and the fields this program does not define, the `identity` and `progress` fields of
 * `local` when the Vault has the subscription, and fresh `schedule` fields.
 */
export function importedSubscription(local: SubscriptionRecord | undefined, incoming: SubscriptionRecord): SubscriptionRecord {
  const merged: Record<string, unknown> = { ...incoming };
  if (local) {
    for (const field of LOCAL_FIELDS) {
      if (local[field] === undefined) delete merged[field];
      else merged[field] = local[field];
    }
  }
  const record = merged as unknown as SubscriptionRecord;
  for (const [field, value] of Object.entries(IMPORTED_SCHEDULE).map(([field, rule]) => [field, rule(record)] as const)) {
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  return record;
}

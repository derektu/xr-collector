import { canonicalJson } from '../core/canonical-json.js';
import type { SubscriptionRecord } from '../core/subscription-types.js';

/**
 * The part of a subscription each field of its record belongs to. What a change stamps, what an
 * import compares and what it takes from either machine all follow from this table, and the type
 * requires every field of `SubscriptionRecord` in it, so a new field cannot go unclassified.
 *
 * - `identity`: names the subscription and says when this Vault first had it; an import keeps the
 *   local value.
 * - `person`: what a person sets, and `updatedAt`, when they last set it. A change of any of them
 *   but `updatedAt` stamps `updatedAt` and counts as a change in an import, which takes the whole
 *   group from the side whose `updatedAt` is newer. A pause the subscription makes itself is a
 *   result of this machine's checks, not a setting: `enabled` counts as on while it lasts (`personValue`).
 * - `progress`: what this machine's checks found. An import keeps the local value of a subscription
 *   the Vault has, also when the local record lacks the field, because the other machine's progress
 *   describes checks this Vault never ran against its own documents.
 * - `schedule`: when the scheduler acts next and when the subscription paused itself; an import sets
 *   each from `IMPORTED_SCHEDULE`, taking neither side as it is.
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

/** Whether the subscription paused itself after its checks kept failing, and has not been resumed. */
function pausedItself(record: SubscriptionRecord): boolean {
  return !record.enabled && record.autoPausedAt !== undefined;
}

/**
 * A person field as the person set it. `enabled` stays on through a pause the subscription made
 * itself, so that pause neither stamps `updatedAt` nor travels to another machine.
 */
function personValue<K extends keyof SubscriptionRecord>(record: SubscriptionRecord, field: K): SubscriptionRecord[K] {
  return (field === 'enabled' ? record.enabled || pausedItself(record) : record[field]) as SubscriptionRecord[K];
}

/**
 * The schedule fields of a subscription an import writes, from the local record, if any, and the
 * incoming one. The next check and the last submission start over, so the scheduler plans the
 * subscription one interval after the import. A pause this Vault's subscription made itself stays
 * while the incoming person setting leaves the subscription on; a pause by the person replaces it.
 * The other machine's own pause never arrives.
 */
const IMPORTED_SCHEDULE: { [K in FieldsOf<'schedule'>]: (local: SubscriptionRecord | undefined, incoming: SubscriptionRecord) => SubscriptionRecord[K] } = {
  nextCheckAt: () => null,
  lastDispatchedAt: () => null,
  autoPausedAt: (local, incoming) => (local && pausedItself(local) && personValue(incoming, 'enabled') ? local.autoPausedAt : undefined),
};

/**
 * What a person sets on a subscription, as text that is equal exactly when those fields are:
 * the `person` fields other than `updatedAt`, with `enabled` as the person set it. Collection
 * progress, check times, a pause the subscription made itself and fields the program does not use
 * are left out, so they never count as a change of the subscription.
 */
export function subscriptionContent(record: SubscriptionRecord): string {
  return canonicalJson(Object.fromEntries(CONTENT_FIELDS.map((field) => [field, personValue(record, field)])));
}

/**
 * The subscription an import writes when it takes `incoming` from the other machine: its `person`
 * fields as the person set them and the fields this program does not define, the `identity` and
 * `progress` fields of `local` when the Vault has the subscription, and fresh `schedule` fields. A
 * subscription that stays paused by itself stays off. One that arrives new after pausing itself on
 * the other machine arrives on, without the failures that paused it there.
 */
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

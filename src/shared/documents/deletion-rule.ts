/**
 * Whether a document collected at `collectedAt` belongs to the deletion made at `deletedAt`. Equal
 * times count as before the deletion, so a deletion always wins a tie; an explicit re-collection
 * stamps its document after the deletion time. A missing or unreadable `collected_at` cannot prove
 * the document newer, so the deletion wins as well.
 */
export function collectedBeforeDeletion(collectedAt: string | undefined, deletedAt: string): boolean {
  return !collectedAtReadable(collectedAt) || Date.parse(collectedAt) <= Date.parse(deletedAt);
}

/** Whether a document's `collected_at` is a time the deletion rule can compare. */
export function collectedAtReadable(collectedAt: unknown): collectedAt is string {
  return typeof collectedAt === 'string' && !Number.isNaN(Date.parse(collectedAt));
}

import { publishedSince } from '../core/published.js';
import type { CheckRange, ListedItem, SubscriptionTarget } from '../core/source-contract.js';
import type { CandidateSelection, CheckPlan } from '../jobs/subscription-port.js';

/**
 * The plan of one check of `target` over `range`. Items in `excluded` (out of range for a range
 * that starts no earlier, or skipped after failing) and items with a document stay candidates that
 * are not collected, so they still fill the item limit.
 */
export function checkPlan(target: SubscriptionTarget, range: CheckRange, excluded: ReadonlySet<string>): CheckPlan {
  return {
    target,
    select: (listing, hasDocument) => selectCandidates(listing, range, async (key) => excluded.has(key) || hasDocument(key)),
  };
}

/**
 * Decides which items one check of a subscription collects, reading the listing newest first. The
 * candidates are the newest `maxItems` eligible items published since `since`; of them, the ones
 * `isKnown` reports (collected, deleted or known to be outside the range) are dropped and the rest
 * collected. A dropped candidate is never replaced by an older item, so a check collects nothing
 * older than the newest `maxItems` items of its range. Reading stops at the first item before the
 * range, and once the candidates are complete, so the source lists no more than the check needs.
 *
 * Listing publish times may be approximate. An item without one counts as inside the range, and
 * the capture confirms the exact time against `publishedNotBefore`.
 */
export async function selectCandidates(
  listing: AsyncIterable<ListedItem>,
  range: CheckRange,
  isKnown: (key: string) => Promise<boolean>,
): Promise<CandidateSelection> {
  const candidates: ListedItem[] = [];
  if (range.maxItems > 0) {
    for await (const item of listing) {
      if (!item.eligible) continue;
      // The listing is newest first, so the first item before the range ends the scan.
      if (!publishedSince(item.publishedAt, range.since)) break;
      candidates.push(item);
      if (candidates.length >= range.maxItems) break;
    }
  }
  const items: ListedItem[] = [];
  for (const item of candidates) if (!(await isKnown(item.key))) items.push(item);
  return { candidates: candidates.map((item) => item.key), items, publishedNotBefore: range.since.toISOString() };
}

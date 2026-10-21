import { publishedSince } from '../core/published.js';
import type { CheckRange, ListedItem } from '../plugins/types.js';

export interface CandidateSelection {
  /** Keys of every candidate, collected or not, newest first. */
  candidates: string[];
  /** Items to collect, newest first. */
  items: ListedItem[];
  /** The start of the range; a capture skips an item whose exact publish time is earlier. */
  publishedNotBefore: string;
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

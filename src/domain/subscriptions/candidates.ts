import { publishedSince } from '../../shared/documents/published.js';
import type { CheckRange, ListedItem, SubscriptionTarget } from '../../shared/sources/source-contract.js';
import type { DocumentStatus } from '../../shared/documents/document-types.js';
import type { CandidateSelection, CheckPlan } from '../jobs/index.js';

export function checkPlan(
  target: SubscriptionTarget, range: CheckRange, excluded: ReadonlySet<string>, documentStatus: DocumentStatus,
): CheckPlan {
  return {
    target,
    documentStatus,
    select: (listing, hasDocument) => selectCandidates(listing, range, async (key) => excluded.has(key) || hasDocument(key)),
  };
}

export async function selectCandidates(
  listing: AsyncIterable<ListedItem>,
  range: CheckRange,
  isKnown: (key: string) => Promise<boolean>,
): Promise<CandidateSelection> {
  const candidates: ListedItem[] = [];
  if (range.maxItems > 0) {
    for await (const item of listing) {
      if (!item.eligible) continue;
      if (!publishedSince(item.publishedAt, range.since)) break;
      candidates.push(item);
      if (candidates.length >= range.maxItems) break;
    }
  }
  const items: ListedItem[] = [];
  for (const item of candidates) if (!(await isKnown(item.key))) items.push(item);
  return { candidates: candidates.map((item) => item.key), items, publishedNotBefore: range.since.toISOString() };
}

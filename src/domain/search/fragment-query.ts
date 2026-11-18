import { normalizeSearchText } from './search-normalization.js';
import type { SearchLexicon } from './search-lexicon.js';

export const SEARCH_QUERY_STRATEGY_REVISION = 1;

export interface FragmentQueryPlan {
  normalized: string;
  /** Exact normalized substrings. Every group is required, but groups may occur in different fields. */
  groups: string[];
  /** Unquoted non-Han terms whose typo/prefix behavior remains owned by Meilisearch. */
  latinQuery: string;
  hasHan: boolean;
}

/** Converts a user query into Jieba word groups without using result labels or document contents. */
export function planFragmentQuery(rawQuery: string, lexicon: SearchLexicon): FragmentQueryPlan {
  const normalized = normalizeSearchText(rawQuery);
  const groups: string[] = [];
  const latinTerms: string[] = [];
  for (const match of normalized.matchAll(/"([^"]*)"|([^"\s]+)/gu)) {
    const text = match[1] ?? match[2] ?? '';
    if (!text) continue;
    if (match[1] !== undefined) {
      if (hasHan(text)) groups.push(text);
      else latinTerms.push(`"${text}"`);
      continue;
    }
    let singletons = '';
    let previousEnd: number | null = null;
    const flush = () => {
      if (singletons) groups.push(singletons);
      singletons = '';
      previousEnd = null;
    };
    for (const token of lexicon.cut(text)) {
      const adjacent = previousEnd === null || previousEnd === token.start;
      if (isSingleHan(token.word) && adjacent) {
        singletons += token.word;
        previousEnd = token.end;
        continue;
      }
      flush();
      if (hasHan(token.word)) {
        groups.push(token.word);
      } else if (/^[\p{L}\p{N}]+$/u.test(token.word)) {
        latinTerms.push(token.word);
      }
    }
    flush();
  }
  return {
    normalized,
    groups: [...new Set(groups)],
    latinQuery: latinTerms.join(' '),
    hasHan: groups.some(hasHan),
  };
}

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function isSingleHan(value: string): boolean {
  return /^\p{Script=Han}$/u.test(value);
}

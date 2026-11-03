// A query of nothing but Unicode spaces browses the documents instead of searching for blanks; the
// spaces inside a query stay, since they separate the groups every result must match.
import { describe, expect, it } from 'vitest';
import { trimSearchQueryWhitespace } from '../../src/core/search-query.js';

describe('search query whitespace', () => {
  it('trims every Unicode White_Space at the ends, so a blank query is empty', () => {
    expect(trimSearchQueryWhitespace('\u0085 　')).toBe('');
    expect(trimSearchQueryWhitespace(' \n\t　')).toBe('');
  });

  it('keeps the spaces inside a query and its punctuation', () => {
    expect(trimSearchQueryWhitespace('　半導體 個股、 ')).toBe('半導體 個股、');
  });
});

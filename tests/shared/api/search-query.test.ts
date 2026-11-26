// Broken, a query of Unicode spaces searches for blanks, or a query loses the spaces that separate its groups.
import { describe, expect, it } from 'vitest';
import { trimSearchQueryWhitespace } from '../../../src/shared/api/search-query.js';

describe('search query whitespace', () => {
  it('trims every Unicode White_Space at the ends, so a blank query is empty', () => {
    expect(trimSearchQueryWhitespace('\u0085 　')).toBe('');
    expect(trimSearchQueryWhitespace(' \n\t　')).toBe('');
  });

  it('keeps the spaces inside a query and its punctuation', () => {
    expect(trimSearchQueryWhitespace('　半導體 個股、 ')).toBe('半導體 個股、');
  });
});

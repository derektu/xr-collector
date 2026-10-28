/** Trims Unicode White_Space without changing punctuation, accents, or internal query boundaries. */
export function trimSearchQueryWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

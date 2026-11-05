import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the developer, not the user: a presentation test that compares a whole Chinese sentence
// breaks every time the wording changes, and its fix is copying the new sentence, so the rule the
// test meant to protect (a count, a branch, which state wins) goes unchecked. The presentation
// modules return their rules as data and turn that data into words in a separate thin function;
// their tests assert the data. Copy is checked where it is seen, in the screenshots of the ticket
// that changes a screen.
//
// A matcher whose expected value holds a Chinese character fails this test. Chinese test data
// reaches an expectation through a variable, not as a literal in the matcher. The test reads only
// the matcher's own arguments: a sentence held in a variable, in an `it.each` table, or compared on
// the actual side (`expect(text === '…')`) passes it, which keeps the check to one simple rule.

/** Presentation test files with a reason they still compare words; the list only ever shrinks. */
const ALLOWED: Record<string, string> = {};

const MATCHERS = /\.(toBe|toEqual|toStrictEqual|toMatchObject|toContain|toContainEqual|toMatch|toHaveProperty|toThrow|toThrowError)\(/gu;
const HAN = /\p{Script=Han}/u;

function presentationTests(): string[] {
  const web = readdirSync('tests/web').filter((name) => name.endsWith('-presentation.test.ts')).map((name) => path.posix.join('tests/web', name));
  return [...web, 'tests/electron/tray-menu.test.ts', 'tests/electron/app-tray.test.ts'].sort();
}

/** The source text inside the parentheses that open at `start`, without comments. */
function argumentsAt(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  let text = '';
  for (let at = start; at < source.length; at += 1) {
    const char = source[at]!;
    if (quote) {
      text += char;
      if (char === '\\') { text += source[at + 1] ?? ''; at += 1; } else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && source[at + 1] === '/') { at = source.indexOf('\n', at) - 1; if (at < 0) break; continue; }
    if (char === '/' && source[at + 1] === '*') { at = source.indexOf('*/', at) + 1; continue; }
    if (char === '\'' || char === '"' || char === '`') quote = char;
    if (char === '(') depth += 1;
    if (char === ')') { depth -= 1; if (depth === 0) return text.slice(1); }
    text += char;
  }
  return text;
}

/** `file:line` of every matcher whose expected value holds a Chinese character. */
function sentenceComparisons(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(MATCHERS)]
    .filter((match) => HAN.test(argumentsAt(source, match.index + match[0].length - 1)))
    .map((match) => `${file}:${source.slice(0, match.index).split('\n').length}`);
}

describe('presentation tests', () => {
  it('assert rules as data, not whole Chinese sentences', () => {
    const files = presentationTests();
    expect(files).toContain('tests/web/subscription-presentation.test.ts');
    expect(files.filter((file) => !(file in ALLOWED)).flatMap(sentenceComparisons)).toEqual([]);
  });

  it('allow only files that still exist and still compare words', () => {
    expect(Object.keys(ALLOWED).filter((file) => sentenceComparisons(file).length === 0)).toEqual([]);
  });
});

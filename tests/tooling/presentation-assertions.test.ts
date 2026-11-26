// Guards the developer, not the user: a presentation test that compares a whole Chinese sentence breaks on
// every wording change, and copying the new sentence leaves its rule unchecked.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ALLOWED: Record<string, string> = {};

const MATCHERS = /\.(toBe|toEqual|toStrictEqual|toMatchObject|toContain|toContainEqual|toMatch|toHaveProperty|toThrow|toThrowError)\(/gu;
const HAN = /\p{Script=Han}/u;

function presentationTests(): string[] {
  const web = readdirSync('tests/transport/web', { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('-presentation.test.ts'))
    .map((name) => path.posix.join('tests/transport/web', name.split(path.sep).join('/')));
  return [...web, 'tests/desktop/electron/tray-menu.test.ts', 'tests/desktop/electron/tray.test.ts'].sort();
}

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

function sentenceComparisons(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(MATCHERS)]
    .filter((match) => HAN.test(argumentsAt(source, match.index + match[0].length - 1)))
    .map((match) => `${file}:${source.slice(0, match.index).split('\n').length}`);
}

describe('presentation tests', () => {
  it('assert rules as data, not whole Chinese sentences', () => {
    const files = presentationTests();
    expect(files).toContain('tests/transport/web/sources/subscription-presentation.test.ts');
    expect(files.filter((file) => !(file in ALLOWED)).flatMap(sentenceComparisons)).toEqual([]);
  });

  it('allow only files that still exist and still compare words', () => {
    expect(Object.keys(ALLOWED).filter((file) => sentenceComparisons(file).length === 0)).toEqual([]);
  });
});

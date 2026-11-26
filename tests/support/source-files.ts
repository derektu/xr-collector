import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Every file below `directory`, at any depth, as a POSIX path that starts with `directory`. */
export function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/**
 * `text` with every comment blanked to spaces. Line breaks stay, so a line keeps its number and its
 * columns. A `//` after `:` or `\` stays, so a URL or an escaped slash is not taken for a comment.
 */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:\\])(\/\/[^\n]*)/gu, (_match, before: string, comment: string) => `${before}${' '.repeat(comment.length)}`);
}

/** A line with its comments blanked; `topLevel` when the line starts at column 0 and holds code. */
export interface CodeLine {
  number: number;
  code: string;
  topLevel: boolean;
}

/** The lines of `text` with comments blanked. A top-level line drops the blanks a leading block comment left, so its code starts at column 0. */
export function codeLines(text: string): CodeLine[] {
  const original = text.split('\n');
  return withoutComments(text).split('\n').map((line, index) => {
    const startsAtColumnZero = /^\S/u.test(original[index]!) && line.trim().length > 0;
    return { number: index + 1, code: startsAtColumnZero ? line.trimStart() : line, topLevel: startsAtColumnZero };
  });
}

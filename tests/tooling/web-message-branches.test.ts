import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the developer, not the user: a screen that compares, searches or cuts a server message
// changes what it does when only the wording changes, and neither the types nor the tests notice.
// Screens branch on structured fields (`state`, `outcome`, `code`, counts) and only show messages.
// A file under src/web that compares a `.message` with `==`/`===`/`!=`/`!==`, or reads it (also through `?.`) with
// startsWith/endsWith/includes/indexOf/match/slice, fails here.

const BRANCHING = /\.message\s*(?:[!=]==?|\??\.(?:startsWith|endsWith|includes|indexOf|match|slice)\()/u;

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/** `file:line` of every line under src/web that branches on a message's text. */
function messageBranches(): string[] {
  return filesUnder('src/web').filter((file) => /\.tsx?$/u.test(file)).flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .flatMap((line, index) => BRANCHING.test(line) ? [`${file}:${index + 1}`] : []));
}

describe('screens and server messages', () => {
  it('recognizes each way of branching on a message', () => {
    for (const line of ['status.message === x', 'status?.message !== x', 'event.message.startsWith(x)', 'event.message.includes(x)', 'event.message.slice(4)', 'status?.message?.startsWith(x)', 'status.message == x', 'status.message != x']) {
      expect(BRANCHING.test(line)).toBe(true);
    }
    expect(BRANCHING.test('<p>{status.message}</p>')).toBe(false);
    expect(BRANCHING.test('const text = status.message;')).toBe(false);
  });

  it('never branch on the text of a server message', () => {
    expect(messageBranches()).toEqual([]);
  });
});

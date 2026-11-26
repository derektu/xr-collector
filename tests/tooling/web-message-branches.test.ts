// Guards the developer, not the user: a screen that reads a server message's wording breaks when only the
// wording changes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesUnder } from '../support/source-files.js';

const BRANCHING = /\.message\s*(?:[!=]==?|\??\.(?:startsWith|endsWith|includes|indexOf|match|slice)\()/u;

function messageBranches(): string[] {
  return filesUnder('src/transport/web').filter((file) => /\.tsx?$/u.test(file)).flatMap((file) => readFileSync(file, 'utf8').split('\n')
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

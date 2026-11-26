// Guards the developer and the window: code in a shared type file is dragged into the server, the Electron
// shell and the web bundle alike.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeLines } from '../support/source-files.js';

const TYPE_FILES = readdirSync('src/shared', { recursive: true }).map(String).filter((name) => name.endsWith('-types.ts'))
  .map((name) => `src/shared/${name.split(path.sep).join('/')}`);

const TYPE_STATEMENT = /^(?:(?:export\s+)?(?:interface|type)\s|import\s+type\s|export\s+type\s*\{|\})/u;
const VALUE_DECLARATION = /^\s*(?:export\s+)?(?:default\s+|declare\s+|abstract\s+|async\s+)*(?:const|let|var|function|class|enum)\s+[\w${[]/u;

function nonTypeLines(file: string): string[] {
  return codeLines(readFileSync(file, 'utf8')).flatMap(({ number, code, topLevel }) => {
    const nonType = (topLevel && !TYPE_STATEMENT.test(code)) || VALUE_DECLARATION.test(code);
    return nonType ? [`${file}:${number}: ${code.trim()}`] : [];
  });
}

describe('the shared type files', () => {
  it('finds the type files of every block', () => {
    expect(TYPE_FILES).toEqual(expect.arrayContaining([
      'src/shared/documents/document-types.ts', 'src/shared/jobs/job-types.ts', 'src/shared/subscriptions/subscription-types.ts', 'src/shared/activity/activity-types.ts',
    ]));
  });

  it('hold only types and import only types', () => {
    expect(TYPE_FILES.flatMap(nonTypeLines)).toEqual([]);
  });
});

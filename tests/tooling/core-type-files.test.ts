import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the developer and the window: the shared type files (`src/core/*-types.ts`) are imported by
// the server, the Electron shell and the web bundle. A type file that holds code drags that code, and
// whatever it imports, into every one of them, and a change to it looks as if it touched every block.
// So a type file holds only interfaces and type aliases, and imports only types. Values the blocks
// share live in their own modules, such as `CollectorError` in `src/core/collector-error.ts`.

const TYPE_FILES = readdirSync('src/core').filter((name) => name.endsWith('-types.ts')).map((name) => `src/core/${name}`);

/** Comments blanked out, keeping line numbers; a `//` right after `:` stays, because that is a URL in a string. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ''))
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1');
}

/** A line that starts a top-level statement: interfaces, type aliases, type-only imports and the closing brace. */
const TYPE_STATEMENT = /^(?:(?:export\s+)?(?:interface|type)\s|import\s+type\s|export\s+type\s*\{|\})/u;
/** A declaration that makes a value, at any indentation. */
const VALUE_DECLARATION = /^\s*(?:export\s+)?(?:default\s+|declare\s+|abstract\s+|async\s+)*(?:const|let|var|function|class|enum)\s+[\w${[]/u;

/** The lines of a type file that are not types, as `file:line: text`. */
function codeLines(file: string): string[] {
  return withoutComments(readFileSync(file, 'utf8')).split('\n').flatMap((line, index) => {
    const topLevel = line.length > 0 && !/^\s/u.test(line);
    const code = (topLevel && !TYPE_STATEMENT.test(line)) || VALUE_DECLARATION.test(line);
    return code ? [`${file}:${index + 1}: ${line.trim()}`] : [];
  });
}

describe('the shared type files', () => {
  it('finds the type files of every block', () => {
    expect(TYPE_FILES).toEqual(expect.arrayContaining([
      'src/core/document-types.ts', 'src/core/job-types.ts', 'src/core/subscription-types.ts', 'src/core/activity-types.ts',
    ]));
  });

  it('hold only types and import only types', () => {
    expect(TYPE_FILES.flatMap(codeLines)).toEqual([]);
  });
});

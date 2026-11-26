import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { isPublicFile } from '../../tooling/eslint/comment-policy.js';

// Guards the developer, not the user: each rule in eslint.config.ts is proven to report the code it
// is meant to stop, at the right line and with its fix, and to leave alone the places it exempts. A
// rule that silently stops matching lets the next agent copy the pattern it was meant to stop.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = path.join(repoRoot, 'tests', 'tooling', 'fixtures', 'lint');
const eslint = new ESLint({ cwd: repoRoot });

interface Finding {
  rule: string | null;
  line: number;
  message: string;
}

async function lintFixture(name: string, lintedAs: string): Promise<Finding[]> {
  const code = readFileSync(path.join(fixtures, name), 'utf8');
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, lintedAs) });
  return (result?.messages ?? []).map((message) => ({ rule: message.ruleId, line: message.line, message: message.message }));
}

const located = (findings: Finding[]): string[] => findings.map((finding) => `${finding.rule}:${finding.line}`);
const COMMENT_RULE = 'xr-collector/comment-policy';
const TIMERS = 'xr-collector/no-timers';
const EFFECTS = 'xr-collector/no-effect-hooks';

describe('timer rules', () => {
  it('report timer globals, timers reached through global objects and the timers modules, pointing at state waits', async () => {
    const findings = await lintFixture('timers.ts', 'src/domain/jobs/poll.ts');
    expect(located(findings)).toEqual([`${TIMERS}:1`, `${TIMERS}:2`, `${TIMERS}:4`, `${TIMERS}:5`, `${TIMERS}:6`, `${TIMERS}:7`]);
    expect(findings.every((finding) => finding.message.includes('Wait on a state, not on time'))).toBe(true);
    expect(findings[0]?.message).toContain('takes `Timers` from its caller');
    expect(findings.every((finding) => finding.message.includes('docs/code-guidelines.md, section 時間與非同步'))).toBe(true);
  });

  it('report AbortSignal.timeout, also through globalThis, pointing at deadline, and Playwright waitForTimeout', async () => {
    const findings = await lintFixture('deadlines.ts', 'tests/transport/web/flow.test.ts');
    expect(located(findings)).toEqual([`${TIMERS}:3`, `${TIMERS}:4`, `${TIMERS}:5`]);
    expect(findings[0]?.message).toContain('`deadline`');
    expect(findings[1]?.message).toContain('`deadline`');
    expect(findings[2]?.message).toContain('Wait on a state, not on time');
  });

  it('cover src, tests, scripts and the verify skill', async () => {
    for (const lintedAs of ['tests/domain/jobs/poll.test.ts', 'scripts/poll.mjs', '.claude/skills/verify/scripts/lib/poll.mjs', '.claude/skills/verify/flows/poll.mjs']) {
      expect(located(await lintFixture('timers.ts', lintedAs)), lintedAs).toHaveLength(6);
    }
  });

  it('leave a timer type named through typeof alone', async () => {
    expect(await lintFixture('timer-type.ts', 'src/domain/jobs/poll.ts')).toEqual([]);
  });

  it('leave the time module, the UI infra folder, the test helpers and the two wait helpers alone', async () => {
    for (const lintedAs of ['src/shared/lib/time.ts', 'src/transport/web/infra/use-timeout.ts', 'tests/support/wait.ts', 'scripts/lib/wait.mjs', '.claude/skills/verify/scripts/lib/wait.mjs', 'vite.config.ts']) {
      expect(await lintFixture('timers.ts', lintedAs), lintedAs).toEqual([]);
      expect(await lintFixture('deadlines.ts', lintedAs), lintedAs).toEqual([]);
    }
  });
});

describe('effect hook rules', () => {
  it('report useEffect and useLayoutEffect as named imports and as properties, pointing at useSyncExternalStore', async () => {
    const findings = await lintFixture('use-effect.tsx', 'src/transport/web/Title.tsx');
    expect(located(findings)).toEqual([`${EFFECTS}:1`, `${EFFECTS}:1`, `${EFFECTS}:6`, `${EFFECTS}:7`]);
    expect(findings.every((finding) => finding.message.includes('useSyncExternalStore'))).toBe(true);
    expect(findings.every((finding) => finding.message.includes('docs/code-guidelines.md, section React'))).toBe(true);
  });

  it('leave a namespace import of React and its other hooks alone', async () => {
    expect(await lintFixture('react-namespace.tsx', 'src/transport/web/Title.tsx')).toEqual([]);
  });

  it('let the UI infra folder use them under the rules of hooks', async () => {
    expect(await lintFixture('use-effect.tsx', 'src/transport/web/infra/Title.tsx')).toEqual([]);
    expect(located(await lintFixture('hooks-misuse.tsx', 'src/transport/web/infra/use-title.ts'))).toEqual([
      'react-hooks/rules-of-hooks:4',
      'react-hooks/exhaustive-deps:4',
    ]);
  });
});

describe('type rules', () => {
  it('report any everywhere, pointing at unknown', async () => {
    for (const lintedAs of ['src/domain/jobs/parse.ts', 'tests/domain/jobs/parse.test.ts', 'vite.config.ts']) {
      const findings = await lintFixture('any.ts', lintedAs);
      expect(located(findings), lintedAs).toEqual(['no-restricted-syntax:1', 'no-restricted-syntax:1']);
      expect(findings[0]?.message).toContain('Use `unknown`');
    }
  });

  it('report @ts-nocheck, @ts-ignore and @ts-expect-error, pointing at fixing the type', async () => {
    const findings = await lintFixture('ts-directives.ts', 'src/domain/jobs/values.ts');
    expect(located(findings)).toEqual([`${COMMENT_RULE}:1`, `${COMMENT_RULE}:3`, `${COMMENT_RULE}:5`]);
    expect(findings.every((finding) => finding.message.includes('Fix the type instead'))).toBe(true);
    expect(findings[0]?.message).toContain('docs/code-guidelines.md, section 型別');
  });
});

describe('inline configuration', () => {
  it('has no effect: the rules an inline directive switches off still report, and so does the directive', async () => {
    const findings = await lintFixture('lint-directives.ts', 'src/domain/jobs/poll.ts');
    expect(located(findings.filter((finding) => finding.rule !== null))).toEqual([
      `${COMMENT_RULE}:1`,
      `${TIMERS}:2`,
      `${COMMENT_RULE}:3`,
      'no-restricted-syntax:4',
    ]);
    expect(findings.find((finding) => finding.rule === COMMENT_RULE)?.message).toContain('add it to eslint.config.ts');
  });
});

describe('comment rule', () => {
  it('reports explaining comments, and accepts an External: comment with its continuation lines', async () => {
    const findings = await lintFixture('comments.ts', 'src/domain/jobs/orders.ts');
    expect(located(findings)).toEqual([`${COMMENT_RULE}:1`, `${COMMENT_RULE}:3`, `${COMMENT_RULE}:10`, `${COMMENT_RULE}:12`]);
    expect(findings[0]?.message).toContain('renaming, extracting a function, adding a type or writing a test');
    expect(findings[0]?.message).toContain('`// External:`');
    expect(findings[0]?.message).toContain('docs/code-guidelines.md, section Comment');
  });

  it('takes only an SPDX-License-Identifier line before the code as a license header', async () => {
    expect(located(await lintFixture('license-mention.ts', 'src/domain/jobs/orders.ts'))).toEqual([`${COMMENT_RULE}:1`]);
  });

  it('accepts license headers, references, External: comments and tool directives', async () => {
    expect(await lintFixture('compliant.ts', 'src/domain/jobs/orders.ts')).toEqual([]);
  });

  it('accepts doc comments on exported declarations of a public file and their public members only', async () => {
    const findings = await lintFixture('doc-comments.ts', 'src/shared/jobs/reader.ts');
    expect(located(findings)).toEqual([`${COMMENT_RULE}:20`, `${COMMENT_RULE}:22`, `${COMMENT_RULE}:24`, `${COMMENT_RULE}:29`, `${COMMENT_RULE}:47`]);
    expect(findings[0]?.message).toContain('only on an exported declaration of a public file');
    expect(findings[0]?.message).toContain('docs/code-guidelines.md, section Comment');
  });

  it('reports every doc comment in a file no entry re-exports', async () => {
    const findings = await lintFixture('doc-comments.ts', 'src/domain/jobs/reader.ts');
    expect(findings).toHaveLength(17);
    expect(new Set(findings.map((finding) => finding.rule))).toEqual(new Set([COMMENT_RULE]));
  });

  it('treats a file a module entry re-exports as public', async () => {
    expect(await lintFixture('doc-comments.ts', 'src/domain/jobs/subscription-port.ts')).toHaveLength(5);
  });

  it('finds the public files whatever folder ESLint runs from', async () => {
    const fromSrc = new ESLint({ cwd: path.join(repoRoot, 'src') });
    const code = readFileSync(path.join(fixtures, 'doc-comments.ts'), 'utf8');
    const [result] = await fromSrc.lintText(code, { filePath: path.join(repoRoot, 'src/domain/jobs/subscription-port.ts') });
    expect(result?.messages).toHaveLength(5);
  });

  it('applies to src only until tests follow it', async () => {
    expect(await lintFixture('comments.ts', 'tests/domain/jobs/orders.test.ts')).toEqual([]);
  });
});

describe('public files', () => {
  const root = path.join(fixtures, 'public-tree');
  const file = (relative: string) => path.join(root, relative);

  it('are the files under src/shared, the module entries and what they re-export, followed through further re-exports', () => {
    expect(isPublicFile(root, file('src/shared/things/contract.ts'))).toBe(true);
    expect(isPublicFile(root, file('src/domain/things/index.ts'))).toBe(true);
    expect(isPublicFile(root, file('src/domain/things/thing.ts'))).toBe(true);
    expect(isPublicFile(root, file('src/domain/things/nested/index.ts'))).toBe(true);
    expect(isPublicFile(root, file('src/domain/things/deeper.ts'))).toBe(true);
  });

  it('exclude a file only a folder below a module re-exports, and files outside src', () => {
    expect(isPublicFile(root, file('src/domain/things/internal.ts'))).toBe(false);
    expect(isPublicFile(root, file('src/domain/things/deep/index.ts'))).toBe(false);
    expect(isPublicFile(root, file('tests/domain/things/index.ts'))).toBe(false);
  });
});

describe('bulk suppressions', () => {
  const lintSuppressed = (counts: Record<string, Record<string, number>>) => {
    const location = path.join(mkdtempSync(path.join(os.tmpdir(), 'xr-lint-suppressions-')), 'eslint-suppressions.json');
    const suppressions = Object.fromEntries(Object.entries(counts).map(([name, rules]) => [
      `tests/tooling/fixtures/lint/${name}`, Object.fromEntries(Object.entries(rules).map(([rule, count]) => [rule, { count }])),
    ]));
    writeFileSync(location, JSON.stringify(suppressions));
    const files = Object.keys(counts).map((name) => `tests/tooling/fixtures/lint/${name}`);
    return spawnSync(process.execPath, [path.join(repoRoot, 'node_modules/eslint/bin/eslint.js'), '--no-ignore', '--max-warnings', '0', '--suppressions-location', location, ...files], { cwd: repoRoot, encoding: 'utf8' });
  };

  it('pass a file whose violations stay within its recorded count', () => {
    expect(lintSuppressed({ 'suppressed-one.ts': { [TIMERS]: 1 } }).status).toBe(0);
  });

  it('fail lint when a suppressed file gains one more violation, reporting each one', () => {
    const result = lintSuppressed({ 'suppressed-two.ts': { [TIMERS]: 1 } });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/1:1\s+error/u);
    expect(result.stdout).toMatch(/2:1\s+error/u);
  });

  it('fail lint when a file trades a recorded useEffect for a timer', () => {
    const result = lintSuppressed({ 'suppressed-one.ts': { [EFFECTS]: 1 } });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(TIMERS);
  });

  it('fail lint when a suppression no longer matches a violation, until it is pruned', () => {
    const result = lintSuppressed({ 'suppressed-one.ts': { [TIMERS]: 2 } });
    expect(result.status).toBe(2);
    expect(result.stderr + result.stdout).toContain('--prune-suppressions');
  });
});

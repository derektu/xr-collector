import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { commentPolicy } from './tooling/eslint/comment-policy.js';
import { noEffectHooks } from './tooling/eslint/no-effect-hooks.js';
import { noTimers } from './tooling/eslint/no-timers.js';

const ANY_MESSAGE =
  '`any` turns type checking off. Use `unknown` and narrow it with a type guard, or write the actual type. See docs/code-guidelines.md, section 型別.';

const TIMER_FILES = ['src/**', 'tests/**', 'scripts/**', '.claude/skills/verify/**'];
const TIMER_EXCEPTIONS = ['src/shared/lib/time.ts', 'src/transport/web/infra/**', 'tests/support/**', '.claude/skills/verify/scripts/lib/wait.mjs'];
const UI_INFRA_FILES = ['src/transport/web/infra/**'];

export default [
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', '.local/**', '.data/**', '.claude/worktrees/**', 'tests/tooling/fixtures/**'],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { noInlineConfig: true },
    plugins: {
      'xr-collector': { rules: { 'comment-policy': commentPolicy, 'no-effect-hooks': noEffectHooks, 'no-timers': noTimers } },
    },
    rules: {
      'xr-collector/no-effect-hooks': 'error',
      'no-restricted-syntax': ['error', { selector: 'TSAnyKeyword', message: ANY_MESSAGE }],
    },
  },
  {
    files: TIMER_FILES,
    ignores: TIMER_EXCEPTIONS,
    rules: { 'xr-collector/no-timers': 'error' },
  },
  {
    files: ['src/**'],
    rules: { 'xr-collector/comment-policy': 'error' },
  },
  {
    files: UI_INFRA_FILES,
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'xr-collector/no-effect-hooks': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];

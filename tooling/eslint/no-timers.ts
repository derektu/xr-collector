import type { Rule } from 'eslint';
import type { MemberExpression, Node } from 'estree';

const TIMER_GLOBALS = new Set(['setTimeout', 'setInterval']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'global', 'self']);
const TIMER_MODULES = new Set(['timers', 'node:timers', 'timers/promises', 'node:timers/promises']);

const MESSAGES = {
  timer:
    'Wait on a state, not on time. Product code that needs time takes `Timers` from its caller and defaults to `systemTimers`, and polls an outside state through `waitUntil` (src/shared/lib/time.ts), so a test drives it. Screens wait on the user through useTimeout or useDebouncedValue (src/transport/web/infra/timing.ts). Tests await the promise the product resolves or wait through `eventually` (tests/support/wait.ts); scripts wait through scripts/lib/wait.mjs, verify skill scripts through .claude/skills/verify/scripts/lib/wait.mjs. See docs/code-guidelines.md, section 時間與非同步.',
  deadline:
    'AbortSignal.timeout is a timer. Bound an outside operation with `deadline` (src/shared/lib/time.ts; scripts/lib/wait.mjs in scripts), or abort an AbortController the caller owns and passes in, so a test aborts it itself instead of waiting. See docs/code-guidelines.md, section 時間與非同步.',
} as const;

function propertyName(node: MemberExpression): string | null {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  return null;
}

function namesAbortSignal(node: Node): boolean {
  if (node.type === 'Identifier') return node.name === 'AbortSignal';
  return node.type === 'MemberExpression' && propertyName(node) === 'AbortSignal';
}

export const noTimers: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow timers, sleeps and AbortSignal.timeout; wait on a state or take the timer from the caller' },
    messages: MESSAGES,
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === 'string' && TIMER_MODULES.has(node.source.value)) context.report({ node, messageId: 'timer' });
      },
      MemberExpression(node) {
        const name = propertyName(node);
        if (name === 'waitForTimeout') context.report({ node, messageId: 'timer' });
        else if (name !== null && TIMER_GLOBALS.has(name) && node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name)) context.report({ node, messageId: 'timer' });
        else if (name === 'timeout' && namesAbortSignal(node.object)) context.report({ node, messageId: 'deadline' });
      },
      'Program:exit'(program) {
        const globalScope = sourceCode.getScope(program);
        const implicitGlobals = [...TIMER_GLOBALS].flatMap((name) => {
          const variable = globalScope.set.get(name);
          return variable && variable.defs.length === 0 ? variable.references : [];
        });
        const unresolved = globalScope.through.filter((reference) => TIMER_GLOBALS.has(reference.identifier.name));
        for (const reference of [...implicitGlobals, ...unresolved]) {
          const inTypeQuery = (reference.identifier as { parent?: { type: string } }).parent?.type === 'TSTypeQuery';
          if (!inTypeQuery) context.report({ node: reference.identifier, messageId: 'timer' });
        }
      },
    };
  },
};

import type { Rule } from 'eslint';

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect']);

export const noEffectHooks: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow useEffect and useLayoutEffect outside the UI infra folder' },
    messages: {
      effect:
        'Screens do not use useEffect or useLayoutEffect. Handle what the user does in event handlers, compute what the screen shows while rendering, and read external state through useSyncExternalStore. See docs/code-guidelines.md, section React.',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(declaration) {
        if (declaration.source.value !== 'react') return;
        for (const specifier of declaration.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;
          const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);
          if (EFFECT_HOOKS.has(imported)) context.report({ node: specifier, messageId: 'effect' });
        }
      },
      MemberExpression(node) {
        if (!node.computed && node.property.type === 'Identifier' && EFFECT_HOOKS.has(node.property.name)) context.report({ node, messageId: 'effect' });
      },
    };
  },
};

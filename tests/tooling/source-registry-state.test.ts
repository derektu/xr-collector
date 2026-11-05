import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the developer, not the user: the source registry and the subscription exchange are values
// the assembly builds and hands to what reads them. A module-level variable they fill, or a function
// that registers into one, would let a module read types nobody gave it, and two runtimes in one
// process would see each other's types. tests/runtime/source-registration.test.ts runs two such
// runtimes side by side.

const MODULES = ['src/core/source-registry.ts', 'src/core/subscription-exchange.ts'];

/** Comments removed, so a declaration written in a comment is not read. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1');
}

/** Variables declared at the top level of a module: a `let`, `var` or `const` outside any block. */
function moduleVariables(text: string): string[] {
  return [...withoutComments(text).matchAll(/^(?:export\s+)?(?:let|var|const)\s+([\w$]+)/gmu)].map((match) => match[1]!);
}

/** Exported functions whose name says they register something. */
function registrationExports(text: string): string[] {
  return [...withoutComments(text).matchAll(/^export\s+(?:async\s+)?function\s+(register[\w$]*)/gmu)].map((match) => match[1]!);
}

describe('the source registry and the subscription exchange', () => {
  it.each(MODULES)('%s holds no module-level variable and exports no registration function', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(moduleVariables(text), `${file} declares module-level variables`).toEqual([]);
    expect(registrationExports(text), `${file} exports registration functions`).toEqual([]);
  });

  it('reads a module-level variable and a registration function where they are', () => {
    const text = '/** let documented = 1; */\nlet registered = null;\nexport const list = new Map();\n'
      + 'export function registerSources(): void {}\nfunction inner() { let local = 1; }\n';
    expect(moduleVariables(text)).toEqual(['registered', 'list']);
    expect(registrationExports(text)).toEqual(['registerSources']);
  });
});

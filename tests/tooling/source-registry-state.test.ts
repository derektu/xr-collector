// Guards the developer, not the user: a module-level registry lets a module read source types nobody gave it,
// and two runtimes in one process see each other's types.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MODULES = ['src/shared/sources/source-registry.ts', 'src/shared/subscriptions/subscription-exchange.ts'];

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1');
}

function moduleVariables(text: string): string[] {
  return [...withoutComments(text).matchAll(/^(?:export\s+)?(?:let|var|const)\s+([\w$]+)/gmu)].map((match) => match[1]!);
}

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

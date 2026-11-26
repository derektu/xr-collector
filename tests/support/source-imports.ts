import { importsOf, isNodeBuiltin } from '../../tooling/source-structure.js';
import { filesUnder } from './source-files.js';

export { importsOf, isNodeBuiltin, type SourceImport } from '../../tooling/source-structure.js';

export const PRODUCT_SOURCE = /\.(?:ts|tsx|cts)$/u;

/** The product files that compile to code: TypeScript under `src`, without declaration files. */
export function productFiles(): string[] {
  return filesUnder('src').filter((file) => PRODUCT_SOURCE.test(file) && !file.endsWith('.d.ts'));
}

/**
 * Every product file `entry` reaches through imports that keep code, with the import chain that
 * first reaches it. Type-only imports are erased from the compiled output and not walked.
 */
export function codeReachedFrom(entry: string): Map<string, string[]> {
  const reached = new Map<string, string[]>([[entry, [entry]]]);
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.shift()!;
    for (const edge of importsOf(file)) {
      if (edge.typeOnly || edge.target === null || !PRODUCT_SOURCE.test(edge.target) || reached.has(edge.target)) continue;
      reached.set(edge.target, [...reached.get(file)!, edge.target]);
      pending.push(edge.target);
    }
  }
  return reached;
}

/** The imports of a Node built-in module in the files of `reached`, each as `<chain> imports <specifier>`. */
export function nodeImportsIn(reached: ReadonlyMap<string, readonly string[]>): string[] {
  return [...reached].flatMap(([file, chain]) => importsOf(file)
    .filter((edge) => !edge.typeOnly && isNodeBuiltin(edge.specifier))
    .map((edge) => `${chain.join(' -> ')} imports ${edge.specifier}`));
}

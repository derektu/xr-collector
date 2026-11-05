import { createContext, useContext, type ReactNode } from 'react';
import type { SourceDeclarations } from '../core/source-registry.js';

/**
 * The source types the components read, from the root down: a component takes them with
 * `useSourceDeclarations()` and hands them to the presentation functions that name a type's words.
 * Rendering a component outside `SourceDeclarationsProvider` throws, so a page never runs without
 * source types.
 */
const SourceDeclarationsContext = createContext<SourceDeclarations | null>(null);

export function SourceDeclarationsProvider({ value, children }: { value: SourceDeclarations; children: ReactNode }) {
  return <SourceDeclarationsContext.Provider value={value}>{children}</SourceDeclarationsContext.Provider>;
}

export function useSourceDeclarations(): SourceDeclarations {
  const declarations = useContext(SourceDeclarationsContext);
  if (!declarations) throw new Error('No source types are provided');
  return declarations;
}

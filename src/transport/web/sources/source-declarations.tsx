import { createContext, useContext, type ReactNode } from 'react';
import type { SourceDeclarations } from '../../../shared/sources/source-registry.js';

const SourceDeclarationsContext = createContext<SourceDeclarations | null>(null);

export function SourceDeclarationsProvider({ value, children }: { value: SourceDeclarations; children: ReactNode }) {
  return <SourceDeclarationsContext.Provider value={value}>{children}</SourceDeclarationsContext.Provider>;
}

export function useSourceDeclarations(): SourceDeclarations {
  const declarations = useContext(SourceDeclarationsContext);
  if (!declarations) throw new Error('No source types are provided');
  return declarations;
}

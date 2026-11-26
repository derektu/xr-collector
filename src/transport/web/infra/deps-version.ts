import { useState } from 'react';

function sameDeps(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}

export function useDepsVersion(deps: readonly unknown[]): number {
  const [seen, setSeen] = useState({ deps, version: 0 });
  if (sameDeps(seen.deps, deps)) return seen.version;
  const next = { deps, version: seen.version + 1 };
  setSeen(next);
  return next.version;
}

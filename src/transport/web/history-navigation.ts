export interface AppHistoryState { returnable?: boolean; from?: 'source' }

export type BackTarget = { kind: 'history' } | { kind: 'go'; path: string; replace: boolean };

export function isAppHistoryState(value: unknown): value is AppHistoryState {
  if (typeof value !== 'object' || value === null) return false;
  const returnable = 'returnable' in value ? value.returnable : undefined;
  const from = 'from' in value ? value.from : undefined;
  return (returnable === undefined || typeof returnable === 'boolean') && (from === undefined || from === 'source');
}

export function readAppHistoryState(value: unknown): AppHistoryState {
  return isAppHistoryState(value) ? value : {};
}

export function backTarget(state: AppHistoryState, fallback: string, replace = false): BackTarget {
  return state.returnable ? { kind: 'history' } : { kind: 'go', path: fallback, replace };
}

export function openedFromSource(state: AppHistoryState): boolean {
  return state.returnable === true && state.from === 'source';
}

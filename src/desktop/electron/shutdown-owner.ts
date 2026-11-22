export type ShutdownOwner = 'none' | 'person' | 'update';

export type BeforeQuitAction<Runtime> =
  | { kind: 'quit' }
  | { kind: 'wait-for-update' }
  | { kind: 'close-runtime-first'; runtime: Runtime };

export function beforeQuitAction<Runtime>(owner: ShutdownOwner, runtime: Runtime | null): BeforeQuitAction<Runtime> {
  if (runtime === null) return { kind: 'quit' };
  switch (owner) {
    case 'update': return { kind: 'wait-for-update' };
    case 'person': return { kind: 'quit' };
    case 'none': return { kind: 'close-runtime-first', runtime };
  }
}

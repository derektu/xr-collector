export type DesktopNavigationTarget = 'jobs' | 'activity'
  | { kind: 'source'; type: string; id: string }
  | { kind: 'message'; message: string };

interface DesktopNavigationActions {
  navigate(page: 'jobs' | 'activity'): void;
  openSource(type: string, id: string): void;
  announce(message: string): void;
}

/** Applies a native navigation request. */
export function handleDesktopNavigation(target: DesktopNavigationTarget, actions: DesktopNavigationActions): void {
  if (typeof target === 'string') {
    actions.navigate(target);
    return;
  }
  if (target.kind === 'message') {
    actions.announce(target.message);
    return;
  }
  actions.openSource(target.type, target.id);
}

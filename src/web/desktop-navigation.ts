import { sourcePath } from './source-presentation.js';

export type DesktopNavigationTarget = 'jobs' | 'activity'
  | { kind: 'source'; type: string; id: string }
  | { kind: 'message'; message: string };

interface DesktopNavigationActions {
  navigate(page: 'jobs' | 'activity'): void;
  openSource(type: string, id: string): void;
  refresh(): void;
  announce(message: string): void;
}

/**
 * Applies a native navigation request. Reopening the detail already on screen also reloads it:
 * the subscription may have changed outside this renderer since the page last fetched it.
 */
export function handleDesktopNavigation(target: DesktopNavigationTarget, currentPath: string, actions: DesktopNavigationActions): void {
  if (typeof target === 'string') {
    actions.navigate(target);
    return;
  }
  if (target.kind === 'message') {
    actions.announce(target.message);
    return;
  }
  const alreadyOpen = currentPath === sourcePath(target.type, target.id);
  actions.openSource(target.type, target.id);
  if (alreadyOpen) actions.refresh();
}

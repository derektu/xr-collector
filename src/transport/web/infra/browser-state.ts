import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((changed: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

export interface AppLocation { pathname: string; search: string }

const locationListeners = new Set<() => void>();
let shownLocation: AppLocation | null = null;

function subscribeLocation(changed: () => void): () => void {
  locationListeners.add(changed);
  window.addEventListener('popstate', changed);
  return () => {
    locationListeners.delete(changed);
    window.removeEventListener('popstate', changed);
  };
}

function currentLocation(): AppLocation {
  const { pathname, search } = window.location;
  if (shownLocation?.pathname !== pathname || shownLocation.search !== search) shownLocation = { pathname, search };
  return shownLocation;
}

export function useLocation(): AppLocation {
  return useSyncExternalStore(subscribeLocation, currentLocation);
}

export function writeHistory(mode: 'push' | 'replace', state: unknown, url: string): void {
  if (mode === 'push') window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);
  for (const changed of [...locationListeners]) changed();
}

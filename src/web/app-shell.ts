/** The theme the user picks in Settings; `system` follows the operating system's light or dark appearance. */
export type ThemePreference = 'system' | 'dark' | 'light';
/** The theme the screen actually shows. */
export type Theme = 'dark' | 'light';
export const themePreferences: readonly ThemePreference[] = ['system', 'dark', 'light'];
export const defaultThemePreference: ThemePreference = 'system';
export type ShellPage = 'sources' | 'documents' | 'settings' | 'activity';

const pagePaths: Record<ShellPage, string> = { sources: '/', documents: '/documents', settings: '/settings', activity: '/activity' };

export function routeForPath(pathname: string): ShellPage {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized.startsWith('/documents/')) return 'documents';
  if (normalized.startsWith('/sources/')) return 'sources';
  return (Object.entries(pagePaths).find(([, path]) => path === normalized)?.[0] as ShellPage | undefined) ?? 'sources';
}
export function pathForRoute(page: ShellPage): string { return pagePaths[page]; }
export function themePreferenceFromValue(value: unknown): ThemePreference {
  return themePreferences.includes(value as ThemePreference) ? value as ThemePreference : defaultThemePreference;
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/**
 * Radio-group keyboard movement (WAI-ARIA): arrows move to the previous or next option and wrap
 * around, Home and End jump to the ends. Returns null for keys the group does not handle.
 */
export function radioIndexForKey(key: string, current: number, count: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export interface ThemeStore { read(): Promise<ThemePreference>; write(preference: ThemePreference): Promise<void>; }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export function createBrowserThemeStore(storage: StorageLike, key = 'xr-collector.theme'): ThemeStore {
  return { read: async () => themePreferenceFromValue(storage.getItem(key)), write: async (preference) => storage.setItem(key, preference) };
}
export interface ElectronThemeBridge { read(): Promise<unknown>; write(preference: ThemePreference): Promise<void>; }
export function createElectronThemeStore(bridge: ElectronThemeBridge): ThemeStore {
  return { read: async () => themePreferenceFromValue(await bridge.read()), write: (preference) => bridge.write(preference) };
}

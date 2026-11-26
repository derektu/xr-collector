export type ThemePreference = 'system' | 'dark' | 'light';
export type Theme = 'dark' | 'light';
export const themePreferences: readonly ThemePreference[] = ['system', 'dark', 'light'];
export const defaultThemePreference: ThemePreference = 'system';
export type ShellPage = 'sources' | 'documents' | 'jobs' | 'settings' | 'activity';

const pagePaths: Record<ShellPage, string> = { sources: '/', documents: '/documents', jobs: '/jobs', settings: '/settings', activity: '/activity' };

export interface NavigationItem { page: ShellPage; label: string; icon: string }

export const navigation: readonly NavigationItem[] = [
  { page: 'sources', label: '訂閱', icon: 'sources' },
  { page: 'documents', label: '文件', icon: 'documents' },
  { page: 'jobs', label: '工作', icon: 'jobs' },
  { page: 'activity', label: '記錄', icon: 'activity' },
];
export const settingsNavigation: NavigationItem = { page: 'settings', label: '設定', icon: 'settings' };

export const OFFLINE_UNAVAILABLE = '沒有網路時無法使用';

export function offlineCheckedLabel(checkedAt: string, today: Date): string {
  const date = new Date(checkedAt);
  const two = (value: number) => String(value).padStart(2, '0');
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return date.toDateString() === today.toDateString() ? time : `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`;
}

export function jobsBadge(unfinished: number): string | null {
  return unfinished > 0 ? String(unfinished) : null;
}

export function routeForPath(pathname: string): ShellPage {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized.startsWith('/documents/')) return 'documents';
  if (normalized.startsWith('/sources/')) return 'sources';
  return (Object.entries(pagePaths).find(([, path]) => path === normalized)?.[0] as ShellPage | undefined) ?? 'sources';
}
export function pathForRoute(page: ShellPage): string { return pagePaths[page]; }
export function isThemePreference(value: unknown): value is ThemePreference {
  return themePreferences.some((preference) => preference === value);
}
export function themePreferenceFromValue(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : defaultThemePreference;
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

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
export function serializeThemeWrites(store: ThemeStore): ThemeStore {
  let writes: Promise<void> = Promise.resolve();
  return {
    read: () => store.read(),
    write: (preference) => {
      const write = writes.then(() => store.write(preference));
      writes = write.catch(() => undefined);
      return write;
    },
  };
}

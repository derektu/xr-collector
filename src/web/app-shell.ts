export const defaultTheme = 'dark' as const;
export type Theme = typeof defaultTheme | 'light';
export type ShellPage = 'sources' | 'documents' | 'settings' | 'activity';

const pagePaths: Record<ShellPage, string> = { sources: '/', documents: '/documents', settings: '/settings', activity: '/activity' };

export function routeForPath(pathname: string): ShellPage {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized.startsWith('/documents/')) return 'documents';
  if (normalized.startsWith('/sources/')) return 'sources';
  return (Object.entries(pagePaths).find(([, path]) => path === normalized)?.[0] as ShellPage | undefined) ?? 'sources';
}
export function pathForRoute(page: ShellPage): string { return pagePaths[page]; }
export function themeFromValue(value: unknown): Theme { return value === 'light' ? 'light' : defaultTheme; }

export interface ThemeStore { read(): Promise<Theme>; write(theme: Theme): Promise<void>; }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export function createBrowserThemeStore(storage: StorageLike, key = 'xr-collector.theme'): ThemeStore {
  return { read: async () => themeFromValue(storage.getItem(key)), write: async (theme) => storage.setItem(key, theme) };
}
export interface ElectronThemeBridge { read(): Promise<unknown>; write(theme: Theme): Promise<void>; }
export function createElectronThemeStore(bridge: ElectronThemeBridge): ThemeStore {
  return { read: async () => themeFromValue(await bridge.read()), write: (theme) => bridge.write(theme) };
}

export const defaultTheme = 'dark' as const;
export type Theme = typeof defaultTheme | 'light';
export type ShellPage = 'sources' | 'documents' | 'settings' | 'activity';

const pagePaths: Record<ShellPage, string> = { sources: '/', documents: '/documents', settings: '/settings', activity: '/activity' };

export function routeForPath(pathname: string): ShellPage {
  const normalized = pathname.replace(/\/+$/, '') || '/';
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

export type SourceAvailability = 'available' | 'planned' | 'test-only';
export interface SourceDefinition { id: string; label: string; availability: SourceAvailability; description?: string; }
export interface SourceRegistry { get(id: string): SourceDefinition | undefined; publicSources(): SourceDefinition[]; }
export function createSourceRegistry(definitions: SourceDefinition[]): SourceRegistry {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return { get: (id) => byId.get(id), publicSources: () => definitions.filter((definition) => definition.availability !== 'test-only') };
}
export const sourceRegistry = createSourceRegistry([
  { id: 'youtube', label: 'YouTube', availability: 'available', description: '影片、頻道與訂閱的操作將由後續工作接入這個來源位置。' },
  { id: 'rss', label: 'RSS', availability: 'planned', description: '尚未開放的來源。' },
  { id: 'web', label: '一般網頁', availability: 'planned', description: '尚未開放的來源。' },
]);

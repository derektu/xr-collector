export const defaultTheme = 'dark' as const;
export type Theme = typeof defaultTheme | 'light';
export type ShellPage = 'sources' | 'documents' | 'settings' | 'activity';

const pagePaths: Record<ShellPage, string> = { sources: '/', documents: '/documents', settings: '/settings', activity: '/activity' };

export function routeForPath(pathname: string): ShellPage {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized.startsWith('/documents/')) return 'documents';
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
export interface SourceDefinition { id: string; label: string; availability: SourceAvailability; description?: string; view: { heading: string; detail: string }; }
export interface SourceRegistry { get(id: string): SourceDefinition | undefined; open(id: string): SourceDefinition | undefined; publicSources(): SourceDefinition[]; }
export function createSourceRegistry(definitions: SourceDefinition[]): SourceRegistry {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return { get: (id) => byId.get(id), open: (id) => byId.get(id), publicSources: () => definitions.filter((definition) => definition.availability !== 'test-only') };
}
export const sourceRegistry = createSourceRegistry([
  { id: 'youtube', label: 'YouTube', availability: 'available', description: '貼上影片或頻道網址，收集字幕到知識庫。', view: { heading: 'YouTube 來源', detail: '貼上影片或頻道網址，收集字幕到知識庫。' } },
  { id: 'rss', label: 'RSS', availability: 'planned', description: '尚未開放的來源。', view: { heading: 'RSS 來源', detail: 'RSS 尚未開放。' } },
  { id: 'web', label: '一般網頁', availability: 'planned', description: '尚未開放的來源。', view: { heading: '一般網頁來源', detail: '一般網頁來源尚未開放。' } },
]);

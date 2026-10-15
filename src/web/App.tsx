import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceTypeInfo, VaultSetupResult, VaultSetupStatus } from '../core/types.js';
import { Activity } from './Activity.js';
import { AddContent, type AddResult } from './AddContent.js';
import { api } from './api-client.js';
import { createBrowserThemeStore, createElectronThemeStore, defaultTheme, pathForRoute, routeForPath, type ShellPage, type Theme, type ThemeStore } from './app-shell.js';
import { Documents } from './Documents.js';
import { listStateSearch, parseListState, readerIdForPath, readerPath, type DocumentListState } from './document-presentation.js';
import { Icon } from './icons.js';
import { Reader } from './Reader.js';
import { Settings } from './Settings.js';
import { SourceDetail } from './SourceDetail.js';
import { backgroundStatus, parseSourceListState, sourceListSearch, sourcePath, sourceRouteForPath, type SourceListState } from './source-presentation.js';
import { Sources } from './Sources.js';
import { useCollectionStatus } from './use-collection-status.js';
import { VaultOnboarding } from './VaultOnboarding.js';

const onboardingPreviewRequested = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === 'onboarding';
const DevelopmentOnboardingPreview = onboardingPreviewRequested ? lazy(() => import('./dev/OnboardingPreview.js')) : null;

const NOTICE_MS = 5000;

const navigation: Array<{ page: ShellPage; label: string; icon: string }> = [
  { page: 'sources', label: '來源', icon: 'sources' },
  { page: 'documents', label: '文件', icon: 'documents' },
  { page: 'activity', label: '活動', icon: 'activity' },
];

/**
 * History entries the app pushed itself; Back controls return through them instead of jumping to a
 * fixed page. `from` names the page that opened the entry, so its Back control can say where it goes.
 */
interface AppHistoryState { returnable?: boolean; from?: 'source' }

export default function App() {
  if (DevelopmentOnboardingPreview) return <Suspense fallback={<p className="loading">正在載入開發預覽…</p>}><DevelopmentOnboardingPreview /></Suspense>;

  const [location, setLocation] = useState(() => ({ pathname: window.location.pathname, search: window.location.search }));
  const page = routeForPath(location.pathname);
  const readerId = page === 'documents' ? readerIdForPath(location.pathname) : null;
  const sourceRoute = page === 'sources' ? sourceRouteForPath(location.pathname) : null;
  const content = useRef<HTMLElement>(null);
  const bridge = window.xrCollectorTheme;
  const desktop = navigator.userAgent.includes('Electron');
  const store = useMemo<ThemeStore | null>(() => bridge ? createElectronThemeStore(bridge) : desktop ? null : createBrowserThemeStore(window.localStorage), [bridge, desktop]);
  const [theme, setTheme] = useState<Theme>(defaultTheme);
  const [themeReady, setThemeReady] = useState(!bridge);
  const [saving, setSaving] = useState(false);
  const [vault, setVault] = useState<VaultSetupStatus | null>(null);
  const [vaultLoadError, setVaultLoadError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string; key: number } | null>(null);
  const [sourceTypes, setSourceTypes] = useState<SourceTypeInfo[]>([]);
  const ready = vault?.state === 'ready';
  const status = useCollectionStatus(ready);

  useEffect(() => { let active = true; if (!store) { console.warn('Theme preference bridge is unavailable'); setThemeReady(true); return () => { active = false; }; } void store.read().then((stored) => { if (active) setTheme(stored); }).catch((error: unknown) => { console.warn('Unable to read theme preference', error); }).finally(() => { if (active) setThemeReady(true); }); return () => { active = false; }; }, [store]);
  useEffect(() => { const onPopState = () => setLocation({ pathname: window.location.pathname, search: window.location.search }); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, []);
  useEffect(() => { void loadVault(); }, []);
  useEffect(() => { if (ready) api.sourceTypes().then(setSourceTypes).catch(() => undefined); }, [ready]);
  // Focus the page heading after navigation so keyboard and screen reader users start at the new page.
  useEffect(() => {
    const frame = requestAnimationFrame(() => content.current?.querySelector<HTMLElement>('[data-page-heading], .reader-title')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, vault?.state]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  async function loadVault(): Promise<void> { setVaultLoadError(undefined); try { setVault(await api.getVaultSetup()); } catch (error: unknown) { setVaultLoadError(error instanceof Error ? error.message : '無法連線到 Collector 服務。'); } }
  function enterVault(result: VaultSetupResult): void { setVault(result.vault); navigate(result.documentCount > 0 ? 'documents' : 'sources'); }
  function go(pathname: string, search = '', state: AppHistoryState = {}, replace = false): void {
    if (replace) window.history.replaceState(state, '', pathname + search);
    else if (window.location.pathname + window.location.search !== pathname + search) window.history.pushState(state, '', pathname + search);
    setLocation({ pathname, search });
    content.current?.scrollTo({ top: 0 });
  }
  const historyState = (): AppHistoryState => (window.history.state as AppHistoryState | null) ?? {};
  /**
   * Back control of a page opened from inside the app; a page opened directly returns to `fallback`.
   * `replace` drops the current entry, for a page that no longer exists after the action.
   */
  function back(fallback: string, replace = false): void {
    if (historyState().returnable) window.history.back();
    else go(fallback, '', {}, replace);
  }
  function navigate(next: ShellPage): void { go(pathForRoute(next)); }
  const scroller = useCallback(() => content.current, []);
  const listState = parseListState(location.search);
  const onListState = useCallback((next: DocumentListState) => {
    const current = parseListState(window.location.search);
    const search = listStateSearch(next);
    // List changes replace the entry so Back from the Reader returns to the latest list position.
    window.history.replaceState(window.history.state, '', `/documents${search}`);
    setLocation({ pathname: '/documents', search });
    if (next.page !== current.page || next.source !== current.source || next.query !== current.query) content.current?.scrollTo({ top: 0 });
  }, []);
  const sourceListState = parseSourceListState(location.search);
  const onSourceListState = useCallback((next: SourceListState) => {
    const search = sourceListSearch(next);
    window.history.replaceState(window.history.state, '', `/${search}`);
    setLocation({ pathname: '/', search });
  }, []);
  function openDocument(id: string, from?: AppHistoryState['from']): void { go(readerPath(id), '', { returnable: true, ...(from ? { from } : {}) }); }
  function openSource(type: string, id: string): void { go(sourcePath(type, id), '', { returnable: true }); }
  function announce(text: string, tone: 'ok' | 'error' = 'ok'): void {
    setNotice({ tone, text, key: Date.now() });
    status.announce();
  }
  function added(result: AddResult): void {
    setAdding(false);
    announce(result.message);
    if (result.source && !(page === 'sources' && !sourceRoute)) go('/');
  }
  async function persist(next: Theme): Promise<void> { setTheme(next); if (!store) return; setSaving(true); try { await store.write(next); } catch (error: unknown) { console.warn('Unable to save theme preference', error); } finally { setSaving(false); } }

  const themeName = theme === 'light' ? 'silverblue' : 'duskblue';
  if (!themeReady || !vault) return <div className="app-loading" data-theme={themeName}>{vaultLoadError ? <div className="app-load-error" role="alert"><p>{vaultLoadError}</p><button type="button" onClick={() => void loadVault()}>重試</button></div> : <p className="loading" role="status">正在載入…</p>}</div>;
  if (vault.state === 'not_ready') return <div data-theme={themeName}><VaultOnboarding status={vault} onStatus={setVault} onReady={enterVault} /></div>;

  const active = status.active ?? [];
  const background = backgroundStatus(active.length, status.schedule);
  const navItem = (item: { page: ShellPage; label: string; icon: string }) => <button key={item.page} type="button" className={page === item.page ? 'nav-item active' : 'nav-item'}
    aria-current={page === item.page ? 'page' : undefined} title={item.label} onClick={() => navigate(item.page)} data-testid={`nav-${item.page}`}>
    <Icon name={item.icon} size={17} /><span className="nav-label">{item.label}</span>
    {item.page === 'activity' && active.length > 0 ? <span className="nav-badge" aria-label={`${active.length} 項進行中`} data-testid="activity-badge">{active.length}</span> : null}
  </button>;

  let body;
  if (readerId) {
    const fromSource = historyState().returnable === true && historyState().from === 'source';
    body = <Reader key={readerId} id={readerId} backLabel={fromSource ? '來源' : '文件'} onBack={() => back('/documents')} onOpenSource={openSource} />;
  } else if (sourceRoute) {
    body = <SourceDetail key={`${sourceRoute.type}:${sourceRoute.id}`} type={sourceRoute.type} id={sourceRoute.id} sourceTypes={sourceTypes} schedule={status.schedule} revision={status.revision}
      onBack={() => back('/')} onOpenDocument={(id) => openDocument(id, 'source')} onOpenDocuments={(source) => go('/documents', listStateSearch({ query: '', source, page: 1 }), { returnable: true })}
      onOpenActivity={() => navigate('activity')} onChanged={announce}
      onRemoved={(message) => { announce(message); back('/', true); }} />;
  } else if (page === 'sources') {
    body = <Sources state={sourceListState} onState={onSourceListState} sourceTypes={sourceTypes} active={active} schedule={status.schedule} revision={status.revision}
      onAdd={() => setAdding(true)} onOpenSource={openSource} onOpenActivity={() => navigate('activity')} onChanged={announce} />;
  } else if (page === 'documents') {
    body = <Documents state={listState} scroller={scroller} onState={onListState} onOpen={openDocument} onNavigate={navigate} onAdd={() => setAdding(true)} />;
  } else if (page === 'activity') {
    body = <Activity revision={status.revision} />;
  } else {
    body = <Settings vaultPath={vault.vaultPath} theme={theme} themeBusy={!themeReady || saving} onTheme={(next) => void persist(next)} />;
  }

  return <div className={readerId ? 'shell reader-mode' : 'shell'} data-theme={themeName}>
    <aside className="sidebar" aria-label="主要導覽">
      <div className="brand"><span className="brand-mark" aria-hidden="true">XR</span><span className="brand-name">XR Collector</span></div>
      <button type="button" className="button primary add-button" onClick={() => setAdding(true)} title="加入內容" data-testid="add-content"><Icon name="plus" size={16} /><span className="nav-label">加入內容</span></button>
      <nav>
        {navigation.map(navItem)}
        <span className="nav-spacer" />
        {navItem({ page: 'settings', label: '設定', icon: 'settings' })}
      </nav>
      <p className={`background-status ${background.tone}`} data-testid="background-status"><span className="dot" aria-hidden="true" /><span className="nav-label">{background.text}</span></p>
    </aside>
    <main className="content" ref={content}>
      <div className={readerId ? 'page reader-page' : 'page'} data-testid={`page-${readerId ? 'reader' : sourceRoute ? 'source-detail' : page}`}>{body}</div>
      {notice ? <p key={notice.key} className={`toast ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="notice">{notice.text}</p> : null}
    </main>
    {adding ? <AddContent sourceTypes={sourceTypes} onClose={() => setAdding(false)} onDone={added}
      onOpenSource={(type, id) => { setAdding(false); openSource(type, id); }} /> : null}
  </div>;
}

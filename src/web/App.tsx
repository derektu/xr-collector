import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceTypeInfo, VaultSetupResult, VaultSetupStatus } from '../core/types.js';
import { jobRole } from '../core/source-registry.js';
import { Activity } from './Activity.js';
import { Jobs } from './Jobs.js';
import { activityStateSearch, type ActivityViewState } from './activity-presentation.js';
import { AddContent } from './AddContent.js';
import type { AddMode } from './add-menu.js';
import { api } from './api-client.js';
import {
  createBrowserThemeStore, createElectronThemeStore, defaultThemePreference, navigation, offlineCheckedLabel, pathForRoute, resolveTheme, routeForPath, settingsNavigation, jobsBadge,
  type NavigationItem, type ShellPage, type ThemePreference, type ThemeStore,
} from './app-shell.js';
import { Documents } from './Documents.js';
import { listStateSearch, parseListState, readerIdForPath, readerPath, type DocumentListState } from './document-presentation.js';
import { Icon } from './icons.js';
import { Reader } from './Reader.js';
import { Settings } from './Settings.js';
import { SourceDetail } from './SourceDetail.js';
import { displayUrl, parseSourceListState, sourceListSearch, sourcePath, sourceRouteForPath, type SourceListState } from './source-presentation.js';
import { Sources } from './Sources.js';
import { targetNoun } from './subscription-presentation.js';
import { useCollectionStatus } from './use-collection-status.js';
import { VaultOnboarding } from './VaultOnboarding.js';

const onboardingPreviewRequested = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === 'onboarding';
const DevelopmentOnboardingPreview = onboardingPreviewRequested ? lazy(() => import('./dev/OnboardingPreview.js')) : null;

const NOTICE_MS = 5000;

/**
 * History entries the app pushed itself; Back controls return through them instead of jumping to a
 * fixed page. `from` names the page that opened the entry, so its Back control can say where it goes.
 */
interface AppHistoryState { returnable?: boolean; from?: 'source' }

const darkSchemeQuery = '(prefers-color-scheme: dark)';
/** Tracks the operating system's light or dark appearance and updates when it changes. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(darkSchemeQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(darkSchemeQuery);
    const update = () => setDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return dark;
}

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
  const [themePreference, setThemePreference] = useState<ThemePreference>(defaultThemePreference);
  const [themeReady, setThemeReady] = useState(!bridge);
  // Theme writes run one after another so the last choice is the one that stays saved.
  const themeWrites = useRef<Promise<void>>(Promise.resolve());
  const systemDark = useSystemDark();
  const [vault, setVault] = useState<VaultSetupStatus | null>(null);
  const [vaultLoadError, setVaultLoadError] = useState<string>();
  const [adding, setAdding] = useState<AddMode | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string; key: number } | null>(null);
  const [sourceTypes, setSourceTypes] = useState<SourceTypeInfo[]>([]);
  const ready = vault?.state === 'ready';
  const status = useCollectionStatus(ready);

  useEffect(() => { let active = true; if (!store) { console.warn('Theme preference bridge is unavailable'); setThemeReady(true); return () => { active = false; }; } void store.read().then((stored) => { if (active) setThemePreference(stored); }).catch((error: unknown) => { console.warn('Unable to read theme preference', error); }).finally(() => { if (active) setThemeReady(true); }); return () => { active = false; }; }, [store]);
  useEffect(() => { const onPopState = () => setLocation({ pathname: window.location.pathname, search: window.location.search }); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, []);
  useEffect(() => { void loadVault(); }, []);
  // The tray menu opens the window on a page; navigating only touches the history and location state.
  useEffect(() => { window.xrCollectorDesktop?.onNavigate((next) => navigate(next)); }, []);
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

  // A subscription request this window sent that ended without subscribing reports why; its row has
  // left the list. Requests from Agents report only in the log.
  const subscribing = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!status.active) return;
    const current = new Set(status.active.filter((job) => jobRole(job.kind)?.role === 'add').map((job) => job.id));
    const missing = [...subscribing.current].filter((id) => !current.has(id));
    for (const id of missing) subscribing.current.delete(id);
    for (const id of missing) {
      void api.getJob(id).then((job) => {
        // A list read before the request was accepted does not show it yet.
        if (job.state === 'queued' || job.state === 'running') subscribing.current.add(id);
        else if (job.state === 'failed') announce(`無法訂閱「${displayUrl(job.source.url)}」：${job.error?.message ?? `解析${targetNoun(job.source.type)}失敗。`}`, 'error');
      }).catch(() => undefined);
    }
  }, [status.active]);

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
  const onActivityState = useCallback((next: ActivityViewState) => {
    const search = activityStateSearch(next);
    window.history.replaceState(window.history.state, '', `/activity${search}`);
    setLocation({ pathname: '/activity', search });
  }, []);
  function announce(text: string, tone: 'ok' | 'error' = 'ok'): void {
    setNotice({ tone, text, key: Date.now() });
    status.announce();
  }
  /** An add dialog's action was accepted: the dialog closes and the current page stays, without a notice. */
  function added(response: unknown): void {
    setAdding(null);
    const job = (response as { job?: { id?: unknown; kind?: unknown } } | null)?.job;
    if (typeof job?.kind === 'string' && jobRole(job.kind)?.role === 'add' && typeof job.id === 'string') subscribing.current.add(job.id);
    status.announce();
  }
  function persist(next: ThemePreference): void {
    setThemePreference(next);
    if (!store) return;
    themeWrites.current = themeWrites.current.then(() => store.write(next)).catch((error: unknown) => { console.warn('Unable to save theme preference', error); });
  }

  const themeName = resolveTheme(themePreference, systemDark) === 'light' ? 'silverblue' : 'duskblue';
  if (!themeReady || !vault) return <div className="app-loading" data-theme={themeName}>{vaultLoadError ? <div className="app-load-error" role="alert"><p>{vaultLoadError}</p><button type="button" onClick={() => void loadVault()}>重試</button></div> : <p className="loading" role="status">正在載入…</p>}</div>;
  if (vault.state === 'not_ready') return <div data-theme={themeName}><VaultOnboarding status={vault} onStatus={setVault} onReady={enterVault} /></div>;

  const active = status.active ?? [];
  const connectivity = status.schedule?.connectivity;
  const offline = connectivity?.state === 'offline';
  const badge = jobsBadge(active.length);
  const navItem = (item: NavigationItem) => <button key={item.page} type="button" className={page === item.page ? 'nav-item active' : 'nav-item'}
    aria-current={page === item.page ? 'page' : undefined} title={item.label} onClick={() => navigate(item.page)} data-testid={`nav-${item.page}`}>
    <Icon name={item.icon} size={17} /><span className="nav-label">{item.label}</span>
    {item.page === 'jobs' && badge ? <span className="nav-badge" aria-label={`${badge} 項未完成`} data-testid="jobs-badge">{badge}</span> : null}
  </button>;

  let body;
  if (readerId) {
    const fromSource = historyState().returnable === true && historyState().from === 'source';
    body = <Reader key={readerId} id={readerId} backLabel={fromSource ? '訂閱' : '文件'} onBack={() => back('/documents')} onOpenSource={openSource}
      onDeleted={(message) => { announce(message); back('/documents', true); }} />;
  } else if (sourceRoute) {
    body = <SourceDetail key={`${sourceRoute.type}:${sourceRoute.id}`} type={sourceRoute.type} id={sourceRoute.id} sourceTypes={sourceTypes} schedule={status.schedule} revision={status.revision}
      onBack={() => back('/')} onOpenDocument={(id) => openDocument(id, 'source')} onChanged={announce}
      onRemoved={(message) => { announce(message); back('/', true); }} />;
  } else if (page === 'sources') {
    body = <Sources state={sourceListState} onState={onSourceListState} sourceTypes={sourceTypes} schedule={status.schedule} revision={status.revision}
      offline={offline} onAdd={setAdding} onOpenSource={openSource} onChanged={announce} />;
  } else if (page === 'documents') {
    body = <Documents state={listState} revision={status.documentsRevision} offline={offline} scroller={scroller} onState={onListState} onOpen={openDocument} onNavigate={navigate} onAdd={setAdding} onChanged={announce} />;
  } else if (page === 'jobs') {
    body = <Jobs revision={status.revision} offline={offline} onChanged={announce} />;
  } else if (page === 'activity') {
    body = <Activity revision={status.revision} busy={active.length > 0} search={location.search} onState={onActivityState}
      onOpenDocument={(id) => openDocument(id)} onOpenSource={openSource} onChanged={announce} />;
  } else {
    body = <Settings vaultPath={vault.vaultPath} activeJobs={active.length} themePreference={themePreference} onThemePreference={persist} onChanged={announce} />;
  }

  return <div className={readerId ? 'shell reader-mode' : 'shell'} data-theme={themeName}>
    <aside className="sidebar" aria-label="主要導覽">
      <div className="brand"><span className="brand-mark" aria-hidden="true">XR</span><span className="brand-name">XR Collector</span></div>
      <nav>
        {navigation.map(navItem)}
        <span className="nav-spacer" />
        {navItem(settingsNavigation)}
      </nav>
    </aside>
    <main className="content" ref={content}>
      {offline && !readerId ? <p className="offline-banner" role="status" data-testid="offline-banner">
        <Icon name="offline" size={16} />
        <span><strong>目前沒有網路</strong>，恢復後自動檢查。{connectivity.checkedAt ? <span className="muted">（{offlineCheckedLabel(connectivity.checkedAt)} 確認）</span> : null}</span>
      </p> : null}
      <div className={readerId ? 'page reader-page' : 'page'} data-testid={`page-${readerId ? 'reader' : sourceRoute ? 'source-detail' : page}`}>{body}</div>
      {notice ? <p key={notice.key} className={`toast ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="notice">{notice.text}</p> : null}
    </main>
    {adding ? <AddContent mode={adding} sourceTypes={sourceTypes} onClose={() => setAdding(null)} onDone={added}
      onOpenSource={(type, id) => { setAdding(null); openSource(type, id); }} /> : null}
  </div>;
}

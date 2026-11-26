import { useCallback, useMemo, useRef, useState } from 'react';
import type { DeviceUpdateStatus } from '../../shared/api/update-types.js';
import type { SourceTypeInfo } from '../../shared/sources/source-info-types.js';
import type { VaultSetupResult, VaultSetupStatus } from '../../shared/vault/vault-types.js';
import { roleOf } from '../../shared/jobs/job-role.js';
import { Activity } from './activity/Activity.js';
import { Jobs } from './jobs/Jobs.js';
import { activityStateSearch, type ActivityViewState } from './activity/activity-presentation.js';
import { AddContent } from './adding/AddContent.js';
import type { AddMode } from './adding/add-menu.js';
import { api } from './api/api-client.js';
import {
  createBrowserThemeStore, createElectronThemeStore, defaultThemePreference, navigation, offlineCheckedLabel, pathForRoute, resolveTheme, routeForPath, serializeThemeWrites, settingsNavigation, jobsBadge,
  type NavigationItem, type ShellPage, type ThemePreference, type ThemeStore,
} from './shell/app-shell.js';
import { Documents } from './documents/Documents.js';
import { handleDesktopNavigation } from './shell/desktop-navigation.js';
import { backTarget, openedFromSource, readAppHistoryState, type AppHistoryState } from './shell/history-navigation.js';
import { listStateSearch, parseListState, readerIdForPath, readerPath, sameSource, type DocumentListState } from './documents/document-presentation.js';
import { Icon } from './shell/icons.js';
import { Reader } from './documents/Reader.js';
import { Settings } from './settings/Settings.js';
import { SoftwareUpdate } from './settings/SoftwareUpdate.js';
import { sidebarUpdateLabel } from './settings/update-presentation.js';
import { SourceDetail } from './sources/SourceDetail.js';
import { displayUrl, parseSourceListState, sourceListSearch, sourcePath, sourceRouteForPath, type SourceListState } from './sources/source-presentation.js';
import { Sources } from './sources/Sources.js';
import { trackSubscriptionRequests } from './shell/subscription-requests.js';
import { targetNoun } from './sources/subscription-presentation.js';
import { useLocation, useMediaQuery, writeHistory } from './infra/browser-state.js';
import { useDesktopNavigation, useFocusAfterChange, useWindowEvent } from './infra/lifecycle.js';
import { useTimeout } from './infra/timing.js';
import { useChangeStream, useLiveRead } from './infra/use-changes.js';
import { useRead } from './infra/use-read.js';
import { keepInView } from './shell/keep-in-view.js';
import { useCollectionStatus } from './shell/use-collection-status.js';
import { VaultOnboarding } from './vault/VaultOnboarding.js';
import { useSourceDeclarations } from './sources/source-declarations.js';

const NOTICE_MS = 5000;
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const UPDATE_PANEL_ID = 'software-update';
const NO_SOURCE_TYPES: SourceTypeInfo[] = [];

export default function App() {
  const declarations = useSourceDeclarations();

  const today = new Date();
  const location = useLocation();
  const page = routeForPath(location.pathname);
  const readerId = page === 'documents' ? readerIdForPath(location.pathname) : null;
  const sourceRoute = page === 'sources' ? sourceRouteForPath(location.pathname) : null;
  const content = useRef<HTMLElement>(null);
  const bridge = window.xrCollectorTheme;
  const desktop = navigator.userAgent.includes('Electron');
  const store = useMemo<ThemeStore | null>(() => {
    const persisted = bridge ? createElectronThemeStore(bridge) : desktop ? null : createBrowserThemeStore(window.localStorage);
    return persisted && serializeThemeWrites(persisted);
  }, [bridge, desktop]);
  const storedTheme = useRead(async () => {
    if (!store) {
      console.warn('Theme preference bridge is unavailable');
      return defaultThemePreference;
    }
    try {
      return await store.read();
    } catch (error) {
      console.warn('Unable to read theme preference', error);
      return defaultThemePreference;
    }
  }, [store]);
  const [chosenTheme, setThemePreference] = useState<ThemePreference | null>(null);
  const themePreference = chosenTheme ?? storedTheme.value ?? defaultThemePreference;
  const themeReady = !bridge || storedTheme.value !== null;
  const systemDark = useMediaQuery(DARK_SCHEME_QUERY);
  const [vaultAttempt, setVaultAttempt] = useState(0);
  const vaultRead = useRead((signal) => api.getVaultSetup(signal), [vaultAttempt]);
  const [chosenVault, setVault] = useState<VaultSetupStatus | null>(null);
  const vault = chosenVault ?? vaultRead.value;
  const vaultLoadError = vaultRead.error && !vaultRead.pending
    ? (vaultRead.error instanceof Error ? vaultRead.error.message : '無法連線到 Collector 服務。') : undefined;
  const [adding, setAdding] = useState<AddMode | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string; key: number } | null>(null);
  const [update, setUpdate] = useState<DeviceUpdateStatus | null>(null);
  const stopRevealingUpdate = useRef<(() => void) | null>(null);
  const ready = vault?.state === 'ready';
  const sourceTypes = useRead(() => api.sourceTypes(), [], { enabled: ready }).value ?? NO_SOURCE_TYPES;
  const [subscriptions] = useState(trackSubscriptionRequests);
  useChangeStream();
  const status = useCollectionStatus(ready, (active) => {
    void subscriptions.activeListRead(active, (id) => api.getJob(id),
      (job) => announce(`無法訂閱「${displayUrl(job.source.url)}」：${job.error?.message ?? `解析${targetNoun(declarations, job.source.type)}失敗。`}`, 'error'));
  });
  const updateRead = useLiveRead(['update'], (signal) => api.updateStatus(signal), []);
  const [readUpdate, setReadUpdate] = useState(updateRead.value);
  if (readUpdate !== updateRead.value) {
    setReadUpdate(updateRead.value);
    if (updateRead.value) setUpdate(updateRead.value);
  }

  useDesktopNavigation((next) => {
    if (next === 'update') { openUpdate(); return; }
    if (next === 'settings') { navigate('settings'); return; }
    handleDesktopNavigation(next, {
      navigate,
      openSource,
      announce: (message) => announce(message, 'error'),
    });
  });
  useWindowEvent('popstate', stopRevealing);
  useFocusAfterChange(`${location.pathname} ${vault?.state ?? ''}`,
    () => content.current?.querySelector<HTMLElement>('[data-page-heading], .reader-title'));
  useTimeout(() => setNotice(null), notice ? NOTICE_MS : null, notice?.key);

  function enterVault(result: VaultSetupResult): void { setVault(result.vault); navigate(result.documentCount > 0 ? 'documents' : 'sources'); }
  function stopRevealing(): void {
    stopRevealingUpdate.current?.();
    stopRevealingUpdate.current = null;
  }
  function go(pathname: string, search = '', state: AppHistoryState = {}, replace = false): void {
    stopRevealing();
    if (replace) writeHistory('replace', state, pathname + search);
    else if (window.location.pathname + window.location.search !== pathname + search) writeHistory('push', state, pathname + search);
    content.current?.scrollTo({ top: 0 });
  }
  function back(fallback: string, replace = false): void {
    const target = backTarget(readAppHistoryState(window.history.state), fallback, replace);
    if (target.kind === 'history') window.history.back();
    else go(target.path, '', {}, target.replace);
  }
  function navigate(next: ShellPage): void { go(pathForRoute(next)); }
  function openUpdate(): void {
    navigate('settings');
    stopRevealingUpdate.current = keepInView(UPDATE_PANEL_ID, content.current ?? document.body);
  }
  const scroller = useCallback(() => content.current, []);
  const listState = parseListState(location.search);
  const onListState = useCallback((next: DocumentListState) => {
    const current = parseListState(window.location.search);
    const search = listStateSearch(next);
    writeHistory('replace', window.history.state, `/documents${search}`);
    if (next.page !== current.page || !sameSource(next.source, current.source) || next.query !== current.query) content.current?.scrollTo({ top: 0 });
  }, []);
  const sourceListState = parseSourceListState(location.search);
  const onSourceListState = useCallback((next: SourceListState) => {
    const search = sourceListSearch(next);
    writeHistory('replace', window.history.state, `/${search}`);
  }, []);
  function openDocument(id: string, from?: AppHistoryState['from']): void { go(readerPath(id), '', { returnable: true, ...(from ? { from } : {}) }); }
  function openSource(type: string, id: string): void { go(sourcePath(type, id), '', { returnable: true }); }
  const onActivityState = useCallback((next: ActivityViewState) => {
    const search = activityStateSearch(next);
    writeHistory('replace', window.history.state, `/activity${search}`);
  }, []);
  function announce(text: string, tone: 'ok' | 'error' = 'ok'): void {
    setNotice({ tone, text, key: Date.now() });
  }
  function added(response: unknown): void {
    setAdding(null);
    subscriptions.sent(response, (kind) => roleOf(declarations, { kind }) === 'add');
  }
  function persist(next: ThemePreference): void {
    setThemePreference(next);
    void store?.write(next).catch((error: unknown) => { console.warn('Unable to save theme preference', error); });
  }

  const themeName = resolveTheme(themePreference, systemDark) === 'light' ? 'silverblue' : 'duskblue';
  if (!themeReady || !vault) return <div className="app-loading" data-theme={themeName}>{vaultLoadError ? <div className="app-load-error" role="alert"><p>{vaultLoadError}</p><button type="button" onClick={() => setVaultAttempt((value) => value + 1)}>重試</button></div> : <p className="loading" role="status">正在載入…</p>}</div>;
  if (vault.state === 'not_ready') return <div data-theme={themeName}>{page === 'settings'
    ? <div className="onboarding-screen" data-testid="device-settings-without-vault">
      <header className="onboarding-header"><div className="onboarding-brand"><span className="brand-mark" aria-hidden="true">XR</span><span>XR Collector</span></div>
        <button type="button" className="onboarding-settings-back" onClick={() => go('/')}>返回知識庫設定</button></header>
      <main className="onboarding-main"><section className="onboarding-card" aria-labelledby="device-settings-title">
        <p className="eyebrow">App 設定</p><h1 id="device-settings-title" data-page-heading tabIndex={-1}>App 更新</h1>
        <p className="onboarding-intro">v{update?.currentVersion ?? '—'}。App 更新屬於這台裝置，不需要先建立或開啟知識庫。</p>
        <SoftwareUpdate status={update} onStatus={setUpdate} />
      </section></main>
    </div>
    : <VaultOnboarding status={vault} onStatus={setVault} onReady={enterVault} />}</div>;

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
    const fromSource = openedFromSource(readAppHistoryState(window.history.state));
    body = <Reader key={readerId} id={readerId} backLabel={fromSource ? '訂閱' : '文件'} onBack={() => back('/documents')} onOpenSource={openSource}
      onDeleted={(message) => { announce(message); back('/documents', true); }} />;
  } else if (sourceRoute) {
    body = <SourceDetail key={`${sourceRoute.type}:${sourceRoute.id}`} type={sourceRoute.type} id={sourceRoute.id} sourceTypes={sourceTypes} schedule={status.schedule}
      onBack={() => back('/')} onOpenDocument={(id) => openDocument(id, 'source')} onNotice={announce}
      onRemoved={(message) => { announce(message); back('/', true); }} />;
  } else if (page === 'sources') {
    body = <Sources state={sourceListState} onState={onSourceListState} sourceTypes={sourceTypes} schedule={status.schedule}
      offline={offline} onAdd={setAdding} onOpenSource={openSource} onNotice={announce} />;
  } else if (page === 'documents') {
    body = <Documents state={listState} offline={offline} scroller={scroller} onState={onListState} onOpen={openDocument} onNavigate={navigate} onAdd={setAdding} onNotice={announce} />;
  } else if (page === 'jobs') {
    body = <Jobs offline={offline} onNotice={announce} />;
  } else if (page === 'activity') {
    body = <Activity search={location.search} onState={onActivityState}
      onOpenDocument={(id) => openDocument(id)} onOpenSource={openSource} onNotice={announce} />;
  } else {
    body = <Settings vaultPath={vault.vaultPath}
      themePreference={themePreference} update={update} onUpdate={setUpdate} onThemePreference={persist} onNotice={announce} />;
  }
  const updateLabel = update ? sidebarUpdateLabel(update) : null;

  return <div className={readerId ? 'shell reader-mode' : 'shell'} data-theme={themeName}>
    <aside className="sidebar" aria-label="主要導覽">
      <div className="brand"><span className="brand-mark" aria-hidden="true">XR</span><span className="brand-name">XR Collector</span></div>
      <nav>
        {navigation.map(navItem)}
        <span className="nav-spacer" />
        {update ? <button type="button" className="sidebar-update" onClick={openUpdate}
          data-testid="sidebar-update" data-phase={updateLabel ? update.phase : 'none'}><span className="nav-label">v{update.currentVersion}{updateLabel ? ` · ${updateLabel}` : ''}</span></button> : null}
        {navItem(settingsNavigation)}
      </nav>
    </aside>
    <main className="content" ref={content}>
      {offline && !readerId ? <p className="offline-banner" role="status" data-testid="offline-banner" data-checked-at={connectivity.checkedAt ?? undefined}>
        <Icon name="offline" size={16} />
        <span><strong>目前沒有網路</strong>，恢復後自動檢查。{connectivity.checkedAt ? <span className="muted">（{offlineCheckedLabel(connectivity.checkedAt, today)} 確認）</span> : null}</span>
      </p> : null}
      <div className={readerId ? 'page reader-page' : 'page'} data-testid={`page-${readerId ? 'reader' : sourceRoute ? 'source-detail' : page}`}>{body}</div>
      {notice ? <p key={notice.key} className={`toast ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="notice" data-tone={notice.tone}>{notice.text}</p> : null}
    </main>
    {adding ? <AddContent mode={adding} sourceTypes={sourceTypes} onClose={() => setAdding(null)} onDone={added}
      onOpenSource={(type, id) => { setAdding(null); openSource(type, id); }} /> : null}
  </div>;
}

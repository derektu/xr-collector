import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { VaultSetupResult, VaultSetupStatus } from '../core/types.js';
import { api } from './api-client.js';
import { VaultOnboarding } from './VaultOnboarding.js';
import { YouTubeSource } from './YouTubeSource.js';
import { createBrowserThemeStore, createElectronThemeStore, defaultTheme, pathForRoute, routeForPath, sourceRegistry, type ShellPage, type Theme, type ThemeStore } from './app-shell.js';

const onboardingPreviewRequested = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === 'onboarding';
const DevelopmentOnboardingPreview = onboardingPreviewRequested ? lazy(() => import('./dev/OnboardingPreview.js')) : null;

const navigation: Array<{ page: ShellPage; label: string; icon: string }> = [
  { page: 'sources', label: '收集來源', icon: '◒' }, { page: 'documents', label: '文件', icon: '▤' },
  { page: 'settings', label: '設定', icon: '⚙' }, { page: 'activity', label: '活動記錄', icon: '◷' },
];
const pageTitles: Record<ShellPage, string> = { sources: '收集來源', documents: '文件', settings: '設定', activity: '活動記錄' };

export function SourceView({ source }: { source: NonNullable<ReturnType<typeof sourceRegistry.open>> }) {
  if (source.id === 'youtube') return <YouTubeSource />;
  return <section className="source-view" aria-label="目前來源" data-testid={`source-view-${source.id}`}><h3>{source.view.heading}</h3><p>{source.view.detail}</p></section>;
}

function PageContent({ page, activeSource, vaultPath, onOpenSource }: { page: ShellPage; activeSource: ReturnType<typeof sourceRegistry.open>; vaultPath: string | null; onOpenSource: (id: string) => void }) {
  if (page === 'sources') return <><p className="eyebrow">SOURCES</p><p className="page-intro">從這裡把來源內容加入知識庫。收集在背景執行，送出後可以繼續其他操作。</p><section className="source-grid" aria-label="來源清單">{sourceRegistry.publicSources().map((source) => <article className={`source-card ${source.availability}`} key={source.id} data-testid={`source-${source.id}`}><div className="source-card-heading"><h3>{source.label}</h3><span>{source.availability === 'available' ? '接入位置' : '尚未開放'}</span></div><p>{source.description}</p>{source.availability === 'available' ? <button type="button" onClick={() => onOpenSource(source.id)}>查看來源</button> : <button type="button" disabled>尚未開放</button>}</article>)}</section>{activeSource ? <SourceView source={activeSource} /> : null}</>;
  if (page === 'documents') return <Placeholder eyebrow="DOCUMENTS" title="文件" detail="文件列表、搜尋與閱讀器將由 #26 接入。此頁目前只提供固定的導覽與畫面容器。" />;
  if (page === 'activity') return <Placeholder eyebrow="ACTIVITY" title="活動記錄" detail="工作摘要與持久活動記錄將由 #29 接入。此頁不以示意資料冒充可查詢的活動。" />;
  return <><p className="eyebrow">SETTINGS</p><p className="page-intro">裝置設定與正式 Vault 資料保持分離。</p><section className="settings-grid" aria-label="設定區塊"><article className="setting-card" data-testid="settings-vault"><h3>知識庫</h3><p>目前使用的知識庫位置：</p><code className="setting-path">{vaultPath}</code><p className="source-note">搬移知識庫將由 #31 接入。</p></article><article className="setting-card"><h3>自動收集</h3><p>Global 收集政策將由 #27 接入。</p></article><article className="setting-card"><h3>外觀</h3><p>使用側欄控制切換深色或淺色主題。</p></article></section></>;
}
function Placeholder({ eyebrow, detail }: { eyebrow: string; title: string; detail: string }) { return <><p className="eyebrow">{eyebrow}</p><section className="placeholder"><p>{detail}</p></section></>; }

export default function App() {
  if (DevelopmentOnboardingPreview) return <Suspense fallback={<p className="loading">正在載入開發預覽…</p>}><DevelopmentOnboardingPreview /></Suspense>;

  const [page, setPage] = useState<ShellPage>(() => routeForPath(window.location.pathname));
  const [activeSource, setActiveSource] = useState(() => sourceRegistry.open('youtube'));
  const bridge = window.xrCollectorTheme;
  const desktop = navigator.userAgent.includes('Electron');
  const store = useMemo<ThemeStore | null>(() => bridge ? createElectronThemeStore(bridge) : desktop ? null : createBrowserThemeStore(window.localStorage), [bridge, desktop]);
  const [theme, setTheme] = useState<Theme>(defaultTheme);
  const [themeReady, setThemeReady] = useState(!bridge);
  const [saving, setSaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [vault, setVault] = useState<VaultSetupStatus | null>(null);
  const [vaultLoadError, setVaultLoadError] = useState<string>();

  useEffect(() => { let active = true; if (!store) { console.warn('Theme preference bridge is unavailable'); setThemeReady(true); return () => { active = false; }; } void store.read().then((stored) => { if (active) setTheme(stored); }).catch((error: unknown) => { console.warn('Unable to read theme preference', error); }).finally(() => { if (active) setThemeReady(true); }); return () => { active = false; }; }, [store]);
  useEffect(() => { const onPopState = () => setPage(routeForPath(window.location.pathname)); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, []);
  useEffect(() => { heading.current?.focus(); }, [page, vault?.state]);
  useEffect(() => { void loadVault(); }, []);
  async function loadVault(): Promise<void> { setVaultLoadError(undefined); try { setVault(await api.getVaultSetup()); } catch (error: unknown) { setVaultLoadError(error instanceof Error ? error.message : '無法連線到 Collector 服務。'); } }
  function enterVault(result: VaultSetupResult): void { setVault(result.vault); navigate(result.documentCount > 0 ? 'documents' : 'sources'); }
  function navigate(next: ShellPage): void { const path = pathForRoute(next); if (window.location.pathname !== path) window.history.pushState({}, '', path); setPage(next); }
  async function persist(next: Theme): Promise<void> { setTheme(next); if (!store) return; setSaving(true); try { await store.write(next); } catch (error: unknown) { console.warn('Unable to save theme preference', error); } finally { setSaving(false); } }

  const themeName = theme === 'light' ? 'silverblue' : 'duskblue';
  if (!themeReady || !vault) return <div className="app-loading" data-theme={themeName}>{vaultLoadError ? <div className="app-load-error" role="alert"><p>{vaultLoadError}</p><button type="button" onClick={() => void loadVault()}>重試</button></div> : <p className="loading" role="status">正在載入…</p>}</div>;
  if (vault.state === 'not_ready') return <div data-theme={themeName}><VaultOnboarding status={vault} onStatus={setVault} onReady={enterVault} /></div>;

  return <div className="shell" data-theme={themeName}><aside className="sidebar" aria-label="主要導覽"><div className="brand"><span className="brand-mark" aria-hidden="true">XR</span><span>XR Collector</span></div><nav>{navigation.map((item) => <button key={item.page} type="button" className={`${page === item.page ? 'nav-item active' : 'nav-item'}${item.page === 'activity' ? ' activity-nav' : ''}`} aria-current={page === item.page ? 'page' : undefined} onClick={() => navigate(item.page)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav><fieldset className="theme-control" disabled={!themeReady || saving}><legend>外觀</legend><label><input type="radio" name="theme" checked={theme === 'dark'} onChange={() => void persist('dark')} /> 深色</label><label><input type="radio" name="theme" checked={theme === 'light'} onChange={() => void persist('light')} /> 淺色</label></fieldset><p className="theme-current" aria-live="polite">目前：{theme === 'dark' ? '深色' : '淺色'}</p></aside><main className="content"><div className="page" data-testid={`page-${page}`}><h1 className="page-title" ref={heading} tabIndex={-1}>{pageTitles[page]}</h1><PageContent page={page} activeSource={activeSource} vaultPath={vault.vaultPath} onOpenSource={(id) => setActiveSource(sourceRegistry.open(id))} /></div></main></div>;
}

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ChannelSchedule, CollectionJob, SourceEntry, SourceList, SourceTypeInfo } from '../core/types.js';
import { api } from './api-client.js';
import { ConfirmRemove } from './ConfirmRemove.js';
import { Icon, SourceTypeBadge } from './icons.js';
import {
  checkTimesLine,
  collectingSummary,
  filterSources,
  showsSingleItems,
  shortTimeLabel,
  sourcePath,
  sourceStatusLabel,
  type SourceListState,
} from './source-presentation.js';

export interface SourcesProps {
  state: SourceListState;
  onState: (state: SourceListState) => void;
  sourceTypes: SourceTypeInfo[];
  active: CollectionJob[];
  schedule: ChannelSchedule | null;
  /** Changes whenever background work changes, so the list reloads. */
  revision: number;
  onAdd: () => void;
  onOpenSource: (type: string, id: string) => void;
  onOpenActivity: () => void;
  /** Reports a finished action and refreshes the shell's view of background work. */
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
}

/** All sources in one list, with type and name filters and per-row pause, resume and more actions. */
export function Sources({ state, onState, sourceTypes, active, schedule, revision, onAdd, onOpenSource, onOpenActivity, onChanged }: SourcesProps) {
  const [list, setList] = useState<SourceList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [draft, setDraft] = useState(state.query);

  useEffect(() => {
    const controller = new AbortController();
    api.listSources(controller.signal).then((next) => { setList(next); setLoadError(null); }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '無法讀取來源。');
    });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => { setDraft(state.query); }, [state.query]);

  async function checkAll(): Promise<void> {
    setChecking(true);
    try {
      const submissions = await api.checkAllChannels();
      onChanged(`已開始檢查 ${submissions.length} 個來源。`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '無法開始檢查。', 'error');
    } finally {
      setChecking(false);
    }
  }

  async function setAutoCollection(enabled: boolean): Promise<void> {
    setSwitching(true);
    try {
      await api.setAutoCollection(enabled);
      onChanged(enabled ? '已開啟自動收集。' : '已暫停自動收集。');
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '無法變更自動收集。', 'error');
    } finally {
      setSwitching(false);
    }
  }

  const sources = list?.sources ?? [];
  const visible = filterSources(sources, state);
  const enabledCount = sources.filter((source) => source.enabled).length;
  const single = list && showsSingleItems(state, list.unsubscribed.documentCount) ? list.unsubscribed : null;
  const empty = list !== null && sources.length === 0 && list.unsubscribed.documentCount === 0;
  const typeLabel = (type: string) => sourceTypes.find((candidate) => candidate.id === type);

  return <>
    <div className="page-header">
      <h1 className="page-title" tabIndex={-1} data-page-heading>來源</h1>
      <div className="header-actions">
        {schedule ? <label className="header-switch" data-testid="auto-collection">
          自動收集
          <input type="checkbox" role="switch" checked={schedule.enabled} disabled={switching}
            onChange={(event) => void setAutoCollection(event.target.checked)} data-testid="auto-collection-switch" />
          <span className="switch" aria-hidden="true" />
        </label> : null}
        <button type="button" className="button" disabled={checking || enabledCount === 0} onClick={() => void checkAll()} data-testid="check-all">
          <Icon name="refresh" size={15} />{checking ? '檢查中…' : '立即檢查'}
        </button>
        <button type="button" className="button" onClick={onAdd}><Icon name="plus" size={15} />新增來源</button>
      </div>
    </div>

    {active.length > 0 ? <button type="button" className="collecting-banner" onClick={onOpenActivity} data-testid="collecting-banner">
      <span className="pulse" aria-hidden="true" /><span>{collectingSummary(active)}</span><span className="banner-link">查看活動</span>
    </button> : null}

    {loadError ? <p className="load-error" role="alert">{loadError}</p> : null}
    {list === null && !loadError ? <p className="loading" role="status">正在讀取…</p> : null}

    {empty ? <section className="empty-state" data-testid="sources-empty">
      <h2>還沒有來源</h2>
      <p>貼上 YouTube 影片或頻道網址開始收集。訂閱頻道後，新影片會自動加入知識庫。</p>
      <button type="button" className="button primary" onClick={onAdd}><Icon name="plus" size={15} />加入內容</button>
    </section> : null}

    {list && !empty ? <>
      <div className="filter-bar">
        <div className="chips" role="group" aria-label="來源類型">
          <button type="button" className={state.type ? 'chip' : 'chip active'} aria-pressed={!state.type} onClick={() => onState({ ...state, type: '' })}>全部 <span>{sources.length}</span></button>
          {sourceTypes.map((type) => <button key={type.id} type="button" className={state.type === type.id ? 'chip active' : 'chip'} aria-pressed={state.type === type.id}
            onClick={() => onState({ ...state, type: type.id })}><Icon name={type.icon} size={14} />{type.label} <span>{list.types.find((entry) => entry.type === type.id)?.count ?? 0}</span></button>)}
        </div>
        <label className="filter-input">
          <span className="visually-hidden">篩選來源</span>
          <Icon name="search" size={14} />
          <input type="search" value={draft} placeholder="篩選來源" onChange={(event) => { setDraft(event.target.value); onState({ ...state, query: event.target.value }); }} data-testid="sources-filter" />
        </label>
      </div>

      <div className="source-table" role="table" aria-label="來源清單" data-testid="source-table">
        <div className="source-row head" role="row">
          <span role="columnheader">名稱</span><span role="columnheader" className="numeric">文件</span><span role="columnheader">最近新增</span><span role="columnheader">狀態</span><span role="columnheader"><span className="visually-hidden">動作</span></span>
        </div>
        {visible.map((source) => <SourceRow key={`${source.type}:${source.id}`} source={source} icon={typeLabel(source.type)?.icon ?? 'file'}
          onOpen={() => onOpenSource(source.type, source.id)} onChanged={onChanged} />)}
        {single ? <div className="source-row single" role="row" data-testid="single-items-row">
          <span role="cell" className="source-name"><SourceTypeBadge icon="file" /><span><span className="name">單篇收集</span><span className="kind">不屬於訂閱來源的文件</span></span></span>
          <span role="cell" className="numeric">{single.documentCount}</span>
          <span role="cell" className="muted">{single.lastCollectedAt ? shortTimeLabel(single.lastCollectedAt) : '—'}</span>
          <span role="cell" /><span role="cell" />
        </div> : null}
        {visible.length === 0 && !single ? <p className="table-empty" data-testid="sources-no-match">沒有符合的來源。</p> : null}
      </div>
    </> : null}

    {list && !empty && schedule ? <p className="page-footnote" data-testid="check-times">{checkTimesLine(schedule)}</p> : null}
  </>;
}

function SourceRow({ source, icon, onOpen, onChanged }: { source: SourceEntry; icon: string; onOpen: () => void; onChanged: SourcesProps['onChanged'] }) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const paused = source.status === 'paused';

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    setMenuOpen(false);
    try {
      onChanged(await work());
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '操作失敗，請稍後再試。', 'error');
    } finally {
      setBusy(false);
    }
  }

  function open(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpen();
  }

  const toggle = () => void run(async () => {
    await api.setChannelEnabled(source.id, paused);
    return paused ? `已恢復「${source.title}」，開始補收。` : `已暫停「${source.title}」。`;
  });

  return <div className={`source-row ${source.status}`} role="row" data-testid={`source-row-${source.id}`}>
    <span role="cell" className="source-name">
      <SourceTypeBadge icon={icon} />
      <a href={sourcePath(source.type, source.id)} onClick={open}><span className="name">{source.title}</span><span className="kind">{source.kindLabel}</span></a>
    </span>
    <span role="cell" className="numeric">{source.documentCount}</span>
    <span role="cell" className="muted">{source.lastCollectedAt ? shortTimeLabel(source.lastCollectedAt) : '—'}</span>
    <span role="cell"><span className={`status-chip ${source.status}`} title={source.lastError?.message}>{sourceStatusLabel(source)}</span></span>
    <span role="cell" className="row-actions">
      {paused
        ? <button type="button" className="button small" disabled={busy} onClick={toggle}>恢復</button>
        : <button type="button" className="icon-only" disabled={busy} aria-label={`暫停 ${source.title}`} title="暫停" onClick={toggle}><Icon name="pause" size={15} /></button>}
      <div className="menu-anchor" ref={menu}>
        <button type="button" className="icon-only" aria-label={`${source.title} 的更多動作`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Icon name="more" size={15} /></button>
        {menuOpen ? <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpen(); }}>查看詳情</button>
          <button type="button" role="menuitem" disabled={paused} onClick={() => void run(async () => {
            await api.checkChannels([source.id]);
            return `已開始檢查「${source.title}」。`;
          })}>立即檢查</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setRemoving(true); }}>移除</button>
        </div> : null}
      </div>
    </span>
    {removing ? <ConfirmRemove source={source} onCancel={() => setRemoving(false)} onRemoved={(message) => { setRemoving(false); onChanged(message); }} /> : null}
  </div>;
}

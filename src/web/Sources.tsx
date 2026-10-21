import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { CollectionSchedule, PendingSubscription, SubscriptionEntry, SubscriptionList, SourceTypeInfo } from '../core/types.js';
import { subscriptionAddItems, type AddMode } from './add-menu.js';
import { AddMenu } from './AddMenu.js';
import { api } from './api-client.js';
import { ConfirmRemove } from './ConfirmRemove.js';
import { Icon, SourceTypeBadge } from './icons.js';
import {
  checkTimesLine,
  displayUrl,
  filterSources,
  pendingOwner,
  shortTimeLabel,
  sourcePath,
  type SourceListState,
} from './source-presentation.js';
import { subscriptionStatusText, subscriptionStatusTone } from './subscription-presentation.js';

export interface SourcesProps {
  state: SourceListState;
  onState: (state: SourceListState) => void;
  sourceTypes: SourceTypeInfo[];
  schedule: CollectionSchedule | null;
  /** Changes whenever background work changes, so the list reloads. */
  revision: number;
  /** Opens the add dialog the menu item names. */
  onAdd: (mode: AddMode) => void;
  onOpenSource: (type: string, id: string) => void;
  /** Reports a finished action and refreshes the shell's view of background work. */
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
}

/**
 * Every subscription in one list, with type and name filters and per-row pause, resume and more
 * actions. A subscription request appears at once and becomes its subscription row when resolved.
 */
export function Sources({ state, onState, sourceTypes, schedule, revision, onAdd, onOpenSource, onChanged }: SourcesProps) {
  const [list, setList] = useState<SubscriptionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [draft, setDraft] = useState(state.query);

  useEffect(() => {
    const controller = new AbortController();
    api.listSubscriptions(controller.signal).then((next) => { setList(next); setLoadError(null); }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '無法讀取訂閱。');
    });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => { setDraft(state.query); }, [state.query]);

  async function checkAll(): Promise<void> {
    setChecking(true);
    try {
      const submissions = await api.checkAllSubscriptions();
      onChanged(`已開始檢查 ${submissions.length} 個訂閱。`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '無法開始檢查。', 'error');
    } finally {
      setChecking(false);
    }
  }

  async function setAutoCheck(enabled: boolean): Promise<void> {
    setSwitching(true);
    try {
      await api.setAutoCollection(enabled);
      onChanged(enabled ? '已開啟自動檢查。' : '已關閉自動檢查。');
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '無法變更自動檢查。', 'error');
    } finally {
      setSwitching(false);
    }
  }

  const sources = list?.subscriptions ?? [];
  const pending = (list?.pending ?? []).filter((entry) => matchesPending(entry, state));
  const visible = filterSources(sources, state);
  const enabledCount = sources.filter((source) => source.enabled).length;
  const empty = list !== null && sources.length === 0 && list.pending.length === 0;
  const typeLabel = (type: string) => sourceTypes.find((candidate) => candidate.id === type);
  const now = new Date();

  return <>
    <div className="page-header">
      <h1 className="page-title" tabIndex={-1} data-page-heading>訂閱</h1>
      <div className="header-actions">
        {schedule ? <label className="header-switch" data-testid="auto-collection">
          自動檢查
          <input type="checkbox" role="switch" checked={schedule.enabled} disabled={switching}
            onChange={(event) => void setAutoCheck(event.target.checked)} data-testid="auto-collection-switch" />
          <span className="switch" aria-hidden="true" />
        </label> : null}
        <button type="button" className="button" disabled={checking || enabledCount === 0} onClick={() => void checkAll()} data-testid="check-all">
          <Icon name="refresh" size={15} />{checking ? '檢查中…' : '立即檢查'}
        </button>
        <AddMenu label="新增訂閱" items={subscriptionAddItems()} onChoose={onAdd} testId="add-subscription" />
      </div>
    </div>

    {loadError ? <p className="load-error" role="alert">{loadError}</p> : null}
    {list === null && !loadError ? <p className="loading" role="status">正在讀取…</p> : null}

    {empty ? <section className="empty-state" data-testid="sources-empty">
      <h2>還沒有訂閱</h2>
      <AddMenu label="新增訂閱" items={subscriptionAddItems()} onChoose={onAdd} primary align="start" testId="add-subscription-empty" />
    </section> : null}

    {list && !empty ? <>
      <div className="filter-bar">
        <div className="chips" role="group" aria-label="類型">
          <button type="button" className={state.type ? 'chip' : 'chip active'} aria-pressed={!state.type} onClick={() => onState({ ...state, type: '' })}>全部 <span>{sources.length}</span></button>
          {sourceTypes.map((type) => <button key={type.id} type="button" className={state.type === type.id ? 'chip active' : 'chip'} aria-pressed={state.type === type.id}
            onClick={() => onState({ ...state, type: type.id })}><Icon name={type.icon} size={14} />{type.label} <span>{list.types.find((entry) => entry.type === type.id)?.count ?? 0}</span></button>)}
        </div>
        <label className="filter-input">
          <span className="visually-hidden">篩選訂閱</span>
          <Icon name="search" size={14} />
          <input type="search" value={draft} placeholder="篩選訂閱" onChange={(event) => { setDraft(event.target.value); onState({ ...state, query: event.target.value }); }} data-testid="sources-filter" />
        </label>
      </div>

      <div className="source-table" role="table" aria-label="訂閱清單" data-testid="source-table">
        <div className="source-row head" role="row">
          <span role="columnheader">名稱</span><span role="columnheader" className="numeric">文件</span><span role="columnheader">最近新增</span><span role="columnheader">狀態</span><span role="columnheader"><span className="visually-hidden">動作</span></span>
        </div>
        {visible.map((source) => <SourceRow key={`${source.type}:${source.id}`} source={source} icon={typeLabel(source.type)?.icon ?? 'file'} now={now}
          onOpen={() => onOpenSource(source.type, source.id)} onChanged={onChanged} />)}
        {pending.map((entry) => { const owner = pendingOwner(entry); return <div key={entry.jobId} className="source-row pending" role="row" data-testid={`pending-row-${entry.jobId}`}>
          <span role="cell" className="source-name"><SourceTypeBadge icon={owner?.declaration.icon ?? 'file'} />
            <span><span className="name">{entry.title ?? displayUrl(entry.url)}</span><span className="kind">{owner?.kindLabel}</span></span></span>
          <span role="cell" className="numeric">—</span>
          <span role="cell" className="muted">—</span>
          <span role="cell"><span className={`status-chip ${subscriptionStatusTone(entry.checkStatus)}`}>{subscriptionStatusText(entry.checkStatus, now)}</span></span>
          <span role="cell" />
        </div>; })}
        {visible.length === 0 && pending.length === 0 ? <p className="table-empty" data-testid="sources-no-match">沒有符合的訂閱。</p> : null}
      </div>
    </> : null}

    {list && !empty && schedule ? <p className="page-footnote" data-testid="check-times">{checkTimesLine(schedule)}</p> : null}
  </>;
}

/** A subscription request matches the filters by the type that owns its address and by its address or resolved title. */
function matchesPending(entry: PendingSubscription, state: SourceListState): boolean {
  const query = state.query.trim().toLocaleLowerCase();
  return (!state.type || state.type === pendingOwner(entry)?.declaration.id)
    && (!query || (entry.title ?? entry.url).toLocaleLowerCase().includes(query));
}

function SourceRow({ source, icon, now, onOpen, onChanged }: { source: SubscriptionEntry; icon: string; now: Date; onOpen: () => void; onChanged: SourcesProps['onChanged'] }) {
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
    await api.setSubscriptionEnabled(source.type, source.id, paused);
    return paused ? `已恢復「${source.title}」，開始檢查。` : `已暫停「${source.title}」。`;
  });

  return <div className={`source-row ${source.status}`} role="row" data-testid={`source-row-${source.id}`}>
    <span role="cell" className="source-name">
      <SourceTypeBadge icon={icon} />
      <a href={sourcePath(source.type, source.id)} onClick={open}><span className="name">{source.title}</span><span className="kind">{source.kindLabel}</span></a>
    </span>
    <span role="cell" className="numeric">{source.documentCount}</span>
    <span role="cell" className="muted">{source.lastCollectedAt ? shortTimeLabel(source.lastCollectedAt) : '—'}</span>
    <span role="cell"><span className={`status-chip ${subscriptionStatusTone(source.checkStatus)}`} data-testid="subscription-status">{subscriptionStatusText(source.checkStatus, now)}</span></span>
    <span role="cell" className="row-actions">
      {paused
        ? <button type="button" className="button small" disabled={busy} onClick={toggle}>恢復</button>
        : <button type="button" className="icon-only" disabled={busy} aria-label={`暫停 ${source.title}`} title="暫停" onClick={toggle}><Icon name="pause" size={15} /></button>}
      <div className="menu-anchor" ref={menu}>
        <button type="button" className="icon-only" aria-label={`${source.title} 的更多動作`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Icon name="more" size={15} /></button>
        {menuOpen ? <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpen(); }}>查看詳情</button>
          <button type="button" role="menuitem" disabled={paused} onClick={() => void run(async () => {
            await api.checkSubscriptions([{ type: source.type, id: source.id }]);
            return `已開始檢查「${source.title}」。`;
          })}>立即檢查</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setRemoving(true); }}>移除</button>
        </div> : null}
      </div>
    </span>
    {removing ? <ConfirmRemove source={source} onCancel={() => setRemoving(false)} onRemoved={(message) => { setRemoving(false); onChanged(message); }} /> : null}
  </div>;
}

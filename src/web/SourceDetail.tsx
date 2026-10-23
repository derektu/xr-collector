import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { settingsErrors } from '../core/collection-settings.js';
import type { CollectionSchedule, SubscriptionDetail as Detail, SourceTypeInfo, SubscriptionSettings } from '../core/types.js';
import { ApiError, api } from './api-client.js';
import { CollectionSettingsFields } from './CollectionSettingsFields.js';
import { ConfirmApplySettings } from './ConfirmApplySettings.js';
import { ConfirmRemove } from './ConfirmRemove.js';
import { readerPath } from './document-presentation.js';
import { Icon } from './icons.js';
import {
  collectionEntryLabel,
  displayUrl,
  initials,
  nextCheckLabel,
  retryCauseLabel,
  shortTimeLabel,
} from './source-presentation.js';
import { subscriptionStatusText, subscriptionStatusTone } from './subscription-presentation.js';

type State = { kind: 'loading' } | { kind: 'ready'; detail: Detail } | { kind: 'missing' } | { kind: 'error'; message: string };
type Saving = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

/** How long a typed number waits before it saves, so a number typed digit by digit saves once. */
const TYPED_SAVE_DELAY_MS = 600;

/**
 * One subscription: its state, counts, collection settings and collection record (collected,
 * failed and skipped items and check summaries), with pause, resume and remove. A chosen option
 * saves at once and a typed number once typing pauses; settings with an invalid value are not
 * saved, and applying them to the other subscriptions waits until they are.
 */
export function SourceDetail({ type, id, sourceTypes, schedule, revision, onBack, onOpenDocument, onChanged, onRemoved }: {
  type: string;
  id: string;
  sourceTypes: SourceTypeInfo[];
  schedule: CollectionSchedule | null;
  revision: number;
  onBack: () => void;
  onOpenDocument: (documentId: string) => void;
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
  onRemoved: (message: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState<Saving>({ kind: 'idle' });
  /** Settings shown while a save is in flight; the saved detail replaces them. */
  const [pending, setPending] = useState<SubscriptionSettings | null>(null);
  /** Settings edited and not sent yet: invalid ones, or a typed number waiting for typing to pause. */
  const [draft, setDraft] = useState<SubscriptionSettings | null>(null);
  const typedSave = useRef<{ timer: ReturnType<typeof setTimeout>; send: () => void } | null>(null);
  const [reload, setReload] = useState(0);
  const saveSequence = useRef(0);
  const saveInFlight = useRef(false);
  /** Saves go out one at a time in the order made, so a later change is never overwritten by an earlier one. */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const controller = new AbortController();
    api.subscriptionDetail(type, id, controller.signal).then((detail) => {
      setState({ kind: 'ready', detail });
      // A reload that answers before the save finished still holds the previous settings.
      if (!saveInFlight.current) setPending(null);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'subscription_not_found') setState({ kind: 'missing' });
      else setState({ kind: 'error', message: error instanceof Error ? error.message : '無法讀取這個訂閱。' });
    });
    return () => controller.abort();
  }, [type, id, revision, reload]);

  // Leaving the page sends a typed number that is still waiting.
  useEffect(() => () => {
    const waiting = typedSave.current;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.send();
    }
  }, []);

  const back = <button type="button" className="back-link" onClick={onBack}><Icon name="back" size={15} />訂閱</button>;
  if (state.kind === 'loading') return <>{back}<p className="loading" role="status">正在讀取…</p></>;
  if (state.kind === 'error') return <>{back}<p className="load-error" role="alert">{state.message}</p></>;
  if (state.kind === 'missing') {
    return <>{back}<section className="empty-state" data-testid="source-missing">
      <h1 className="page-title" tabIndex={-1} data-page-heading>找不到這個訂閱</h1>
    </section></>;
  }

  const { subscription: source, collection } = state.detail;
  const paused = source.status === 'paused';
  const typeInfo = sourceTypes.find((candidate) => candidate.id === source.type);
  const fields = typeInfo?.settings ?? [];

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await api.setSubscriptionEnabled(source.type, source.id, paused);
      onChanged(paused ? `已恢復「${source.title}」，開始檢查。` : `已暫停「${source.title}」。`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '操作失敗，請稍後再試。', 'error');
    } finally {
      setBusy(false);
    }
  }

  function editSettings(patch: Partial<SubscriptionSettings>): void {
    const next = { ...(draft ?? pending ?? source.settings), ...patch } as SubscriptionSettings;
    if (typedSave.current) clearTimeout(typedSave.current.timer);
    typedSave.current = null;
    if (settingsErrors(fields, next).length > 0) {
      setDraft(next);
      setSaving({ kind: 'idle' });
      return;
    }
    const send = () => {
      typedSave.current = null;
      setDraft(null);
      saveSettings(next);
    };
    if (!Object.keys(patch).some((key) => fields.find((field) => field.key === key)?.input === 'number')) {
      send();
      return;
    }
    setDraft(next);
    typedSave.current = { timer: setTimeout(send, TYPED_SAVE_DELAY_MS), send };
  }

  function saveSettings(patch: Partial<SubscriptionSettings>): void {
    const sequence = ++saveSequence.current;
    setPending({ ...(pending ?? source.settings), ...patch } as SubscriptionSettings);
    setSaving({ kind: 'saving' });
    saveInFlight.current = true;
    const send = async () => {
      try {
        await api.updateSubscriptionSettings(source.type, source.id, patch);
        if (sequence !== saveSequence.current) return;
        saveInFlight.current = false;
        setSaving({ kind: 'saved' });
        setReload((value) => value + 1);
      } catch (error) {
        if (sequence !== saveSequence.current) return;
        saveInFlight.current = false;
        setPending(null);
        setSaving({ kind: 'error', message: error instanceof Error ? error.message : '無法儲存，請稍後再試。' });
        setReload((value) => value + 1);
      }
    };
    saveQueue.current = saveQueue.current.then(send);
  }

  function openDocument(event: MouseEvent<HTMLAnchorElement>, documentId: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpenDocument(documentId);
  }

  return <div className="source-detail" data-testid="source-detail">
    {back}
    <header className="detail-header">
      <span className="avatar large" aria-hidden="true">{initials(source.title)}</span>
      <div className="detail-heading">
        <div className="detail-title-line">
          <h1 className="page-title" tabIndex={-1} data-page-heading>{source.title}</h1>
          <span className={`status-chip ${subscriptionStatusTone(source.checkStatus)}`} data-testid="detail-status">{subscriptionStatusText(source.checkStatus)}</span>
        </div>
        <p className="detail-kind"><Icon name={typeInfo?.icon ?? 'file'} size={14} />{source.kindLabel} ·
          <a href={source.url} target="_blank" rel="noopener noreferrer">{displayUrl(source.url)}</a></p>
      </div>
      <div className="header-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void toggle()} data-testid="detail-toggle">
          <Icon name={paused ? 'play' : 'pause'} size={15} />{paused ? '恢復' : '暫停'}
        </button>
        <button type="button" className="button danger-outline" onClick={() => setRemoving(true)}>移除</button>
      </div>
    </header>

    {source.status === 'error' && source.lastError ? <p className="detail-problem" role="alert">最近一次檢查失敗：{source.lastError.message}</p> : null}
    {source.checkStatus.state === 'retrying'
      ? <p className="detail-retry" data-testid="detail-retry-reason">{retryCauseLabel(source.type, source.checkStatus.cause)}</p> : null}

    <dl className="stats">
      <div><dt>文件</dt><dd>{source.documentCount}</dd></div>
      <div><dt>最近新增</dt><dd>{source.lastCollectedAt ? shortTimeLabel(source.lastCollectedAt) : '—'}</dd></div>
      <div><dt>上次檢查</dt><dd>{source.lastCheckedAt ? shortTimeLabel(source.lastCheckedAt) : '尚未檢查'}</dd></div>
      <div><dt>新增時間</dt><dd>{shortTimeLabel(source.addedAt)}</dd></div>
    </dl>

    <section className="panel settings-panel" data-testid="detail-settings">
      <div className="panel-heading">
        <h2>收集設定</h2>
        {saving.kind === 'saving' ? <span className="save-state" role="status">儲存中…</span> : null}
        {saving.kind === 'saved' ? <span className="save-state saved" role="status" data-testid="settings-saved">已儲存</span> : null}
        <span className="panel-spacer" />
        <button type="button" className="button small" disabled={draft !== null} onClick={() => setApplying(true)}
          data-testid="apply-settings">套用到所有 {source.kindLabel}</button>
      </div>
      <div className="panel-body">
        <CollectionSettingsFields idPrefix="detail-settings" type={source.type} fields={fields} value={draft ?? pending ?? source.settings}
          onChange={editSettings} />
        {saving.kind === 'error' ? <p className="add-problem" role="alert">{saving.message}</p> : null}
        <p className="next-check" data-testid="detail-next-check">下次檢查 {nextCheckLabel(source, schedule?.enabled ?? null)}</p>
      </div>
    </section>

    <section className="panel collection-panel" data-testid="detail-collection">
      <div className="panel-heading"><h2>收集紀錄</h2></div>
      {collection.length === 0 ? <p className="panel-text muted">還沒有收集紀錄。</p>
        : <ul className="collection-rows">{collection.map((entry) => {
          const label = collectionEntryLabel(entry, source.type);
          const when = <span className="collection-when">{shortTimeLabel(entry.at)}</span>;
          if (entry.kind === 'collected') {
            return <li key={`document:${entry.documentId}`} className="collection-row collected" data-testid="collection-collected">
              <a href={readerPath(entry.documentId)} onClick={(event) => openDocument(event, entry.documentId)}>
                <Icon name="check" size={16} /><span className="collection-title">{label.title}</span><span />{when}
              </a>
            </li>;
          }
          const key = entry.kind === 'check' ? `check:${entry.jobId}` : `${entry.kind}:${entry.key}`;
          return <li key={key} className={`collection-row ${entry.kind}`} data-testid={`collection-${entry.kind}`}>
            <Icon name={entry.kind === 'check' ? 'jobs' : entry.kind} size={16} />
            <span className="collection-title">{label.title}</span>
            <span className="collection-detail">{label.detail}</span>
            {when}
          </li>;
        })}</ul>}
    </section>

    {applying ? <ConfirmApplySettings source={source} onCancel={() => setApplying(false)}
      onApplied={(message) => { setApplying(false); onChanged(message); }} /> : null}
    {removing ? <ConfirmRemove source={source} onCancel={() => setRemoving(false)} onRemoved={(message) => { setRemoving(false); onRemoved(message); }} /> : null}
  </div>;
}

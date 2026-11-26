import { useRef, useState, type MouseEvent } from 'react';
import { settingsErrors } from '../../../shared/sources/collection-settings.js';
import type {
  CollectionSchedule,
  SubscriptionDetail as Detail,
  SubscriptionSettings,
} from '../../../shared/subscriptions/subscription-types.js';
import type { SourceTypeInfo } from '../../../shared/sources/source-info-types.js';
import { api } from '../api/api-client.js';
import { ApiError } from '../api/api-error.js';
import { useLiveRead } from '../infra/use-changes.js';
import { CollectionSettingsFields } from './CollectionSettingsFields.js';
import { ConfirmApplySettings } from './ConfirmApplySettings.js';
import { ConfirmRemove } from './ConfirmRemove.js';
import { readerPath } from '../documents/document-presentation.js';
import { Icon } from '../shell/icons.js';
import {
  collectionEntryLabel,
  displayUrl,
  initials,
  nextCheckLabel,
  retryCauseLabel,
  shortTimeLabel,
} from './source-presentation.js';
import { subscriptionStatusData, subscriptionStatusText, subscriptionStatusTone } from './subscription-presentation.js';
import { useSourceDeclarations } from './source-declarations.js';
import { editSettingsForm, openSettingsForm, takeUnsent, type SettingsForm } from './settings-form.js';

type State = { kind: 'loading' } | { kind: 'ready'; detail: Detail } | { kind: 'missing' } | { kind: 'error'; message: string };

function readState({ value, error }: { value: Detail | null; error: unknown }): State {
  if (error instanceof ApiError && error.code === 'subscription_not_found') return { kind: 'missing' };
  if (error) return { kind: 'error', message: error instanceof Error ? error.message : '無法讀取這個訂閱。' };
  return value ? { kind: 'ready', detail: value } : { kind: 'loading' };
}
type Saving = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

export function SourceDetail({ type, id, sourceTypes, schedule, onBack, onOpenDocument, onNotice, onRemoved }: {
  type: string;
  id: string;
  sourceTypes: SourceTypeInfo[];
  schedule: CollectionSchedule | null;
  onBack: () => void;
  onOpenDocument: (documentId: string) => void;
  onNotice: (message: string, tone?: 'ok' | 'error') => void;
  onRemoved: (message: string) => void;
}) {
  const declarations = useSourceDeclarations();
  const today = new Date();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState<Saving>({ kind: 'idle' });
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [reload, setReload] = useState(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const read = useLiveRead(['subscriptions'], (signal) => api.subscriptionDetail(type, id, signal), [type, id, reload]);
  const state = readState(read);
  if (state.kind === 'ready' && form?.subscriptionId !== state.detail.subscription.id) {
    setForm(openSettingsForm(state.detail.subscription.id, state.detail.subscription.settings));
  }

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
      onNotice(paused ? `已恢復「${source.title}」，開始檢查。` : `已暫停「${source.title}」。`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '操作失敗，請稍後再試。', 'error');
    } finally {
      setBusy(false);
    }
  }

  const settingsForm = form ?? openSettingsForm(source.id, source.settings);
  const typedKeys = fields.filter((field) => field.input === 'number').map((field) => field.key);

  function editSettings(patch: Partial<SubscriptionSettings>): void {
    const next = editSettingsForm(settingsForm, patch);
    setForm(next);
    const typed = Object.keys(patch).some((key) => typedKeys.includes(key));
    if (typed) setSaving({ kind: 'idle' });
    else commitSettings(next);
  }

  function commitSettings(current: SettingsForm = settingsForm): void {
    if (settingsErrors(fields, current.shown).length > 0) return;
    const { form: sent, patch } = takeUnsent(current);
    if (Object.keys(patch).length === 0) return;
    setForm(sent);
    setSaving({ kind: 'saving' });
    const send = async () => {
      try {
        await api.updateSubscriptionSettings(source.type, source.id, patch);
        setSaving({ kind: 'saved' });
      } catch (error) {
        setSaving({ kind: 'error', message: error instanceof Error ? error.message : '無法儲存，請稍後再試。' });
      }
      setReload((value) => value + 1);
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
          <span className={`status-chip ${subscriptionStatusTone(source.checkStatus)}`} data-testid="detail-status" {...subscriptionStatusData(source.checkStatus)}>{subscriptionStatusText(source.checkStatus, today)}</span>
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

    {source.checkFailures && (source.autoPausedAt || source.status === 'error')
      ? <p className="detail-problem" role="alert" data-testid="detail-problem"
        data-kind={source.autoPausedAt ? 'auto_paused' : 'failing'} data-failures={source.checkFailures.count} data-error-code={source.checkFailures.error.code}>{source.autoPausedAt
        ? `連續失敗 ${source.checkFailures.count} 次，${shortTimeLabel(source.autoPausedAt, today)} 自動暫停：`
        : `最近一次檢查失敗（連續 ${source.checkFailures.count} 次）：`}{source.checkFailures.error.message}</p>
      : null}
    {source.checkStatus.state === 'retrying'
      ? <p className="detail-retry" data-testid="detail-retry-reason" data-cause={source.checkStatus.cause.reason}>{retryCauseLabel(declarations, source.type, source.checkStatus.cause)}</p> : null}

    <dl className="stats">
      <div><dt>文件</dt><dd>{source.documentCount}</dd></div>
      <div><dt>最近新增</dt><dd>{source.lastCollectedAt ? shortTimeLabel(source.lastCollectedAt, today) : '—'}</dd></div>
      <div><dt>上次檢查</dt><dd data-testid="detail-last-checked" data-at={source.lastCheckedAt ?? undefined}>{source.lastCheckedAt ? shortTimeLabel(source.lastCheckedAt, today) : '尚未檢查'}</dd></div>
      <div><dt>新增時間</dt><dd>{shortTimeLabel(source.addedAt, today)}</dd></div>
    </dl>

    <section className="panel settings-panel" data-testid="detail-settings">
      <div className="panel-heading">
        <h2>收集設定</h2>
        {saving.kind === 'saving' ? <span className="save-state" role="status">儲存中…</span> : null}
        {saving.kind === 'saved' ? <span className="save-state saved" role="status" data-testid="settings-saved">已儲存</span> : null}
        <span className="panel-spacer" />
        <button type="button" className="button small" disabled={settingsErrors(fields, settingsForm.shown).length > 0} onClick={() => setApplying(true)}
          data-testid="apply-settings">套用到所有 {source.kindLabel}</button>
      </div>
      <div className="panel-body">
        <CollectionSettingsFields idPrefix="detail-settings" type={source.type} fields={fields} value={settingsForm.shown}
          onChange={editSettings} onCommitNumber={() => commitSettings()} />
        {saving.kind === 'error' ? <p className="add-problem" role="alert">{saving.message}</p> : null}
        <p className="next-check" data-testid="detail-next-check">下次檢查 {nextCheckLabel(source, schedule?.enabled ?? null, today)}</p>
      </div>
    </section>

    <section className="panel collection-panel" data-testid="detail-collection">
      <div className="panel-heading"><h2>收集紀錄</h2></div>
      {collection.length === 0 ? <p className="panel-text muted">還沒有收集紀錄。</p>
        : <ul className="collection-rows">{collection.map((entry) => {
          const label = collectionEntryLabel(declarations, entry, source.type, today);
          const when = <span className="collection-when">{shortTimeLabel(entry.at, today)}</span>;
          if (entry.kind === 'collected') {
            return <li key={`document:${entry.documentId}`} className="collection-row collected" data-testid="collection-collected">
              <a href={readerPath(entry.documentId)} onClick={(event) => openDocument(event, entry.documentId)}>
                <Icon name="check" size={16} /><span className="collection-title">{label.title}</span><span />{when}
              </a>
            </li>;
          }
          if (entry.kind === 'check-group') {
            const failed = entry.result === 'network_error';
            return <li key={entry.groupId} className={`collection-row check${failed ? ' error' : ''}`} data-testid="collection-check-group"
              data-group={entry.groupId} data-result={entry.result} data-count={entry.count}>
              <Icon name={failed ? 'error' : 'jobs'} size={16} />
              <span className="collection-title">{label.title}</span>
              <span className="collection-detail collection-when">{label.detail}</span>
              <a className="inline-link" href={`/activity?${new URLSearchParams({ group: entry.groupId, return: location.pathname }).toString()}`}>查看細節</a>
            </li>;
          }
          const key = entry.kind === 'check' ? `check:${entry.jobId}` : `${entry.kind}:${entry.key}`;
          return <li key={key} className={`collection-row ${entry.kind}`} data-testid={`collection-${entry.kind}`}
            {...(entry.kind === 'check' ? { 'data-job': entry.jobId, 'data-at': entry.at, 'data-created': entry.created, 'data-error-code': entry.error?.code } : {})}>
            <Icon name={entry.kind === 'check' ? 'jobs' : entry.kind} size={16} />
            <span className="collection-title">{label.title}</span>
            <span className="collection-detail">{label.detail}</span>
            {when}
          </li>;
        })}</ul>}
    </section>

    {applying ? <ConfirmApplySettings source={source} onCancel={() => setApplying(false)}
      onApplied={(message) => { setApplying(false); onNotice(message); }} /> : null}
    {removing ? <ConfirmRemove source={source} onCancel={() => setRemoving(false)} onRemoved={(message) => { setRemoving(false); onRemoved(message); }} /> : null}
  </div>;
}

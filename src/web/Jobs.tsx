import { useState, type ReactElement } from 'react';
import type { JobOverview, JobOverviewEntry } from '../core/types.js';
import { api } from './api-client.js';
import { OFFLINE_UNAVAILABLE } from './app-shell.js';
import { Icon, SourceTypeBadge } from './icons.js';
import { jobEntryLabel } from './jobs-presentation.js';
import { useLiveRead } from './use-changes.js';

/**
 * Everything the app is doing now: work that started with what it is doing, work queued in the
 * order it starts, and failed single items with retry and remove. It reads the work again after each change to it.
 */
export function Jobs({ offline, onChanged }: {
  /** The device has no network, so a failed item cannot be retried now. */
  offline: boolean;
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const [acting, setActing] = useState<string | null>(null);
  const read = useLiveRead(['jobs'], (signal) => api.jobOverview(signal), []);
  const overview: JobOverview | null = read.value;
  const error = read.error ? (read.error instanceof Error ? read.error.message : '無法讀取工作。') : null;

  const unfinished = overview ? overview.running.length + overview.queued.length : 0;

  async function act(entry: JobOverviewEntry, action: 'retry' | 'dismiss'): Promise<void> {
    setActing(entry.jobId);
    try {
      if (action === 'retry') await api.retryJob(entry.jobId);
      else await api.dismissJob(entry.jobId);
      onChanged(action === 'retry' ? `已重新排入「${jobEntryLabel(entry).title}」。` : `已移除「${jobEntryLabel(entry).title}」。`);
    } catch (reason) {
      onChanged(reason instanceof Error ? reason.message : '操作失敗，請稍後再試。', 'error');
    } finally {
      setActing(null);
    }
  }

  const header = <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>工作</h1></div>;
  if (error && !overview) return <>{header}<p className="load-error" role="alert">{error}</p></>;
  if (!overview) return <>{header}<p className="loading" role="status">正在讀取…</p></>;
  if (unfinished === 0 && overview.failed.length === 0) {
    return <>{header}<section className="empty-state jobs-empty" data-testid="jobs-empty"><h2>沒有進行中的工作</h2></section></>;
  }

  const row = (entry: JobOverviewEntry, extra: { order?: number; running?: boolean; failed?: boolean }) => {
    const label = jobEntryLabel(entry);
    const progress = extra.running && entry.progress && entry.progress.total > 0 ? entry.progress : null;
    return <li key={entry.jobId} className="job-row" data-testid={`job-${entry.jobId}`}>
      {extra.order !== undefined ? <span className="job-order">{extra.order}</span> : null}
      <SourceTypeBadge icon={label.icon} />
      <span className="job-text">
        <span className="job-title-line">
          <span className={label.named ? 'job-name' : 'job-name address'} title={entry.url}>{label.title}</span>
        </span>
        {extra.failed && label.reason ? <span className="job-sub failed">{label.reason}</span>
          : label.subtitle ? <span className="job-sub">{label.subtitle}</span> : null}
        {label.retryReason ? <span className="job-sub retrying" data-testid="job-retry-reason">{label.retryReason}</span> : null}
        {progress ? <progress value={progress.done} max={progress.total} aria-label={`${label.title}進度`} /> : null}
      </span>
      {label.status ? <span className={`status-chip ${label.status.tone}`} data-testid="job-status">{label.status.text}</span> : null}
      {extra.failed ? <span className="job-actions">
        <button type="button" className="button small" disabled={acting === entry.jobId || offline} title={offline ? OFFLINE_UNAVAILABLE : undefined} onClick={() => void act(entry, 'retry')} data-testid="job-retry">
          <Icon name="refresh" size={14} />重試</button>
        <button type="button" className="button small" disabled={acting === entry.jobId} onClick={() => void act(entry, 'dismiss')} data-testid="job-dismiss">移除</button>
      </span> : null}
    </li>;
  };

  const section = (id: string, title: string, entries: JobOverviewEntry[], render: (entry: JobOverviewEntry, index: number) => ReactElement, ordered = false) => entries.length === 0 ? null
    : <section className="jobs-card" aria-labelledby={`jobs-${id}`} data-testid={`jobs-${id}`}>
      <div className="jobs-card-heading"><h2 id={`jobs-${id}`}>{title}</h2><span className="muted">{entries.length}</span></div>
      {ordered ? <ol className="job-rows">{entries.map(render)}</ol> : <ul className="job-rows">{entries.map(render)}</ul>}
    </section>;

  return <>
    {header}
    {error ? <p className="load-error" role="alert">{error}</p> : null}
    <div className="jobs-sections">
      {section('running', '進行中', overview.running, (entry) => row(entry, { running: true }))}
      {section('queued', '排隊中', overview.queued, (entry, index) => row(entry, { order: index + 1 }), true)}
      {section('failed', '失敗', overview.failed, (entry) => row(entry, { failed: true }))}
    </div>
  </>;
}

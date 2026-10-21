import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ActivityLogHealth, ActivityQuery, JobView, JobEvent, Subscription } from '../core/types.js';
import {
  activityQuery,
  activityStateSearch,
  diagnosticsText,
  eventLevel,
  eventText,
  jobBadge,
  LEVEL_OPTIONS,
  logTime,
  logWarning,
  mergeNewest,
  parseActivityState,
  RANGE_OPTIONS,
  type ActivityViewState,
} from './activity-presentation.js';
import { api } from './api-client.js';
import { sourceDeclaration, sourceDeclarations } from '../core/source-registry.js';
import { Icon } from './icons.js';
import { ACTIVE_POLL_MS } from './use-collection-status.js';
import { readerPath } from './document-presentation.js';
import { jobTitle } from './job-presentation.js';
import { sourcePath } from './source-presentation.js';

const LOG_PAGE = 50;

interface LogState {
  filter: string;
  events: JobEvent[];
  nextCursor: string | null;
  health: ActivityLogHealth;
}

/**
 * The persistent log, filtered by level, source, time and job. Filters live in the address so
 * other pages can open the log already filtered.
 */
export function Activity({ revision, busy, search, onState, onOpenDocument, onOpenSource, onChanged }: {
  revision: number;
  /** Whether work is queued or running; the log then refreshes itself. */
  busy: boolean;
  search: string;
  onState: (next: ActivityViewState) => void;
  onOpenDocument: (id: string) => void;
  onOpenSource: (type: string, id: string) => void;
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const state = parseActivityState(search);
  const filter = activityStateSearch(state);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [log, setLog] = useState<LogState | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [filteredJob, setFilteredJob] = useState<JobView | null>(null);
  // The shell's status poll can miss a job that starts and ends between two polls, such as one an
  // Agent submitted; while this page shows work in progress, it refreshes itself as well.
  const [tick, setTick] = useState(0);
  const refresh = `${revision}:${tick}`;
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), ACTIVE_POLL_MS);
    return () => clearTimeout(timer);
  }, [busy, tick]);

  useEffect(() => {
    const controller = new AbortController();
    api.listSubscriptions(controller.signal)
      .then((list) => setSubscriptions(list.subscriptions)).catch(() => undefined);
    return () => controller.abort();
  }, [revision]);

  // A changed filter starts over; a refresh with the same filter adds new entries above the loaded ones.
  // Refreshes never cancel a request in flight, so frequent progress updates cannot keep the log empty.
  // The time bounds of a filter are fixed when it is first loaded, so "today" keeps meaning the same
  // day and cursors stay valid when the page stays open past midnight.
  const currentFilter = useRef(filter);
  currentFilter.current = filter;
  const filterQuery = useRef<{ filter: string; query: ActivityQuery } | null>(null);
  useEffect(() => {
    setLog(null);
    setLogError(null);
  }, [filter]);

  useEffect(() => {
    const requested = filter;
    if (filterQuery.current?.filter !== requested) filterQuery.current = { filter: requested, query: activityQuery(state, new Date()) };
    api.activity({ ...filterQuery.current.query, limit: LOG_PAGE }).then((page) => {
      if (currentFilter.current !== requested) return;
      setLog((previous) => previous && previous.filter === requested
        ? { ...previous, events: mergeNewest(previous.events, page.events), health: page.log }
        : { filter: requested, events: page.events, nextCursor: page.nextCursor, health: page.log });
      setLogError(null);
    }).catch((error: unknown) => {
      if (currentFilter.current === requested) setLogError(error instanceof Error ? error.message : '無法讀取記錄。');
    });
  }, [filter, refresh]);

  useEffect(() => {
    if (!state.job) { setFilteredJob(null); return undefined; }
    let alive = true;
    api.getJob(state.job).then((job) => { if (alive) setFilteredJob(job); }).catch(() => { if (alive) setFilteredJob(null); });
    return () => { alive = false; };
  }, [state.job, refresh]);

  function change(patch: Partial<ActivityViewState>): void {
    onState({ ...state, ...patch });
  }

  async function loadOlder(): Promise<void> {
    if (!log?.nextCursor) return;
    setLoadingOlder(true);
    try {
      const query = filterQuery.current?.filter === filter ? filterQuery.current.query : activityQuery(state, new Date());
      const page = await api.activity({ ...query, limit: LOG_PAGE, cursor: log.nextCursor });
      setLog((previous) => previous && previous.filter === filter
        ? { ...previous, events: [...previous.events, ...page.events], nextCursor: page.nextCursor, health: page.log }
        : previous);
    } catch (error) {
      setLogError(error instanceof Error ? error.message : '無法讀取更早的記錄。');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function copyDiagnostics(job: JobView): Promise<void> {
    try {
      const page = await api.activity({ jobId: job.id, limit: 100 });
      await navigator.clipboard.writeText(diagnosticsText(job, page.events));
      onChanged('已複製診斷資訊。');
    } catch {
      onChanged('無法複製診斷資訊。', 'error');
    }
  }

  /** Plain clicks stay in the app; modified clicks keep the browser's own link behavior. */
  function open(event: MouseEvent, action: () => void): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    action();
  }

  const warning = logWarning(log?.health ?? null);
  const sourceKnown = !state.source || subscriptions.some((subscription) => subscription.id === state.source);

  return <>
    <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>記錄</h1></div>

    <section className="activity-card log-card" aria-labelledby="activity-log" data-testid="activity-log">
      <div className="log-toolbar">
        <h2 id="activity-log">記錄</h2>
        <div className="chips" role="group" aria-label="等級">
          {LEVEL_OPTIONS.map((option) => <button key={option.value} type="button" className={state.level === option.value ? 'chip active' : 'chip'}
            aria-pressed={state.level === option.value} onClick={() => change({ level: option.value })} data-testid={`level-${option.value}`}>{option.label}</button>)}
        </div>
        <span className="panel-spacer" />
        <label className="source-select"><span className="visually-hidden">訂閱</span>
          <select value={state.source ?? ''} onChange={(event) => change({ source: event.target.value || null })} data-testid="log-source">
            <option value="">所有訂閱</option>
            {subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.title}</option>)}
            {sourceKnown ? null : <option value={state.source!}>{state.source}</option>}
          </select>
        </label>
        <label className="source-select"><span className="visually-hidden">時間</span>
          <select value={state.range} onChange={(event) => change({ range: event.target.value as ActivityViewState['range'] })} data-testid="log-range">
            {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {state.job ? <div className="log-job-filter" data-testid="log-job-filter">
        <span className="chip active">工作：{filteredJob ? `${jobBadge(filteredJob)}・${jobTitle(filteredJob)}` : '…'}
          <button type="button" className="chip-clear" aria-label="清除工作篩選" onClick={() => change({ job: null })}>×</button></span>
        {filteredJob ? <button type="button" className="button small" onClick={() => void copyDiagnostics(filteredJob)} data-testid="copy-diagnostics">複製診斷資訊</button> : null}
      </div> : null}
      {warning ? <p className="log-warning" role="alert" data-testid="log-warning">{warning}</p> : null}
      {logError ? <p className="load-error activity-pad" role="alert">{logError}</p> : null}
      {log === null ? <p className="job-empty activity-pad">正在讀取…</p>
        : log.events.length === 0 ? <p className="job-empty activity-pad">這段期間沒有符合的記錄。</p>
          : <ol className="log-rows">{log.events.map((event) => {
            const level = eventLevel(event);
            const text = eventText(event);
            const documentId = event.documentId;
            const subscriptionId = event.subscriptionId;
            // An entry written before events named their source type belongs to the first type with subscriptions.
            const subscriptionType = event.sourceType ?? sourceDeclarations().find((declaration) => declaration.subscription)?.id ?? '';
            const type = event.sourceType ? sourceDeclaration(event.sourceType) : undefined;
            return <li key={event.eventId} className={`log-row level-${level.toLowerCase()}`} data-testid="log-row">
              <time dateTime={event.timestamp}>{logTime(event.timestamp)}</time>
              <span className="log-level">{level}</span>
              <span className={type ? `log-type type-${type.icon}` : 'log-type'}>
                {type ? <Icon name={type.icon} size={14} label={type.label} /> : null}
              </span>
              {documentId
                ? <a href={readerPath(documentId)} onClick={(click) => open(click, () => onOpenDocument(documentId))}>{text}</a>
                : subscriptionId
                  ? <a href={sourcePath(subscriptionType, subscriptionId)} onClick={(click) => open(click, () => onOpenSource(subscriptionType, subscriptionId))}>{text}</a>
                  : <span>{text}</span>}
            </li>;
          })}</ol>}
      {log?.nextCursor ? <div className="activity-more"><button type="button" className="button small" disabled={loadingOlder} onClick={() => void loadOlder()} data-testid="load-older">
        {loadingOlder ? '正在讀取…' : '載入更早的記錄'}</button></div> : null}
    </section>
  </>;
}

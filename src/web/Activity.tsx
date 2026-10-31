import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ActivityGroupPage, ActivityLogHealth, ActivityQuery, ActivitySummaryEntry, JobView, JobEvent, Subscription } from '../core/types.js';
import {
  activityQuery,
  activityStateSearch,
  diagnosticsText,
  eventLevel,
  eventText,
  jobBadge,
  MIN_LEVEL_OPTIONS,
  RECORD_TYPE_OPTIONS,
  logTime,
  logWarning,
  mergeNewest,
  parseActivityState,
  RANGE_OPTIONS,
  summaryRange,
  type ActivityViewState,
} from './activity-presentation.js';
import { api, ApiError } from './api-client.js';
import { sourceDeclaration, sourceDeclarations } from '../core/source-registry.js';
import { Icon } from './icons.js';
import { useChanges } from './use-changes.js';
import { readerPath } from './document-presentation.js';
import { jobTitle } from './job-presentation.js';
import { failureLabel, sourcePath, sourceRouteForPath } from './source-presentation.js';
import { itemCount, itemNoun } from './subscription-presentation.js';

const LOG_PAGE = 50;

interface LogState {
  filter: string;
  events: JobEvent[];
  entries: ActivitySummaryEntry[];
  nextCursor: string | null;
  health: ActivityLogHealth;
}

/**
 * The persistent log, filtered by level, source, time and job. Filters live in the address so
 * other pages can open the log already filtered.
 */
export function Activity({ search, onState, onOpenDocument, onOpenSource, onChanged }: {
  search: string;
  onState: (next: ActivityViewState) => void;
  onOpenDocument: (id: string) => void;
  onOpenSource: (type: string, id: string) => void;
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const state = parseActivityState(search);
  const effectiveMode = state.job ? 'raw' : state.mode;
  const filter = activityStateSearch({ ...state, mode: effectiveMode });
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [log, setLog] = useState<LogState | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [filteredJob, setFilteredJob] = useState<JobView | null>(null);
  const summaryLocked = useRef(false);
  const logGeneration = useRef(0);
  const subscriptionChanges = useChanges(['subscriptions']);
  const logChanges = useChanges(['activity']);
  const jobChanges = useChanges(['jobs']);
  /** The log request in flight; a change meanwhile reads the log once more when it ends. */
  const logFlight = useRef<{ filter: string; again: boolean } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    subscriptionChanges.track(api.listSubscriptions(controller.signal).then((list) => setSubscriptions(list.subscriptions)));
    return () => controller.abort();
  }, [subscriptionChanges.tick]);

  // A changed filter starts over. Raw refreshes add new entries above loaded history. Summary refreshes
  // replace the whole snapshot until an older page is requested; pagination then keeps that snapshot
  // fixed until a filter/mode change or page reload, so rows and cursors can never cross snapshots.
  // Refreshes never cancel a request in flight, so frequent progress updates cannot keep the log empty.
  // The time bounds of a filter are fixed when it is first loaded, so "today" keeps meaning the same
  // day and cursors stay valid when the page stays open past midnight.
  const currentFilter = useRef(filter);
  currentFilter.current = filter;
  const filterQuery = useRef<{ filter: string; query: ActivityQuery } | null>(null);
  useEffect(() => {
    summaryLocked.current = false;
    logGeneration.current += 1;
    logFlight.current = null;
    setLog(null);
    setLogError(null);
    setLoadingOlder(false);
  }, [filter]);

  useEffect(() => {
    const requested = filter;
    if (effectiveMode === 'summary' && summaryLocked.current) { logChanges.track(Promise.resolve()); return; }
    if (logFlight.current?.filter === requested) { logFlight.current.again = true; return; }
    if (filterQuery.current?.filter !== requested) filterQuery.current = { filter: requested, query: activityQuery(state, new Date()) };
    const query = filterQuery.current.query;
    const load = (): void => {
      const flight = { filter: requested, again: false };
      logFlight.current = flight;
      const reading = read();
      logChanges.track(reading);
      void reading.catch(() => undefined).then(() => {
        if (logFlight.current !== flight) return;
        logFlight.current = null;
        if (flight.again) load();
      });
    };
    const read = () => (effectiveMode === 'summary'
      ? api.activitySummary({ ...query, limit: LOG_PAGE })
      : api.activity({ ...query, limit: LOG_PAGE })).then((page) => {
      if (currentFilter.current !== requested) return;
      if (effectiveMode === 'summary' && summaryLocked.current) return;
      const events = 'events' in page ? page.events : [];
      const entries = 'entries' in page ? page.entries : [];
      setLog((previous) => previous && previous.filter === requested && effectiveMode === 'raw'
        ? { ...previous, events: mergeNewest(previous.events, events), entries: [], health: page.log }
        : { filter: requested, events, entries, nextCursor: page.nextCursor, health: page.log });
      setLogError(null);
    }).catch((error: unknown) => {
      if (currentFilter.current === requested && !(effectiveMode === 'summary' && summaryLocked.current)) {
        setLogError(error instanceof Error ? error.message : '無法讀取記錄。');
      }
      throw error;
    });
    load();
  }, [filter, logChanges.tick, effectiveMode]);

  useEffect(() => {
    if (!state.job) { setFilteredJob(null); jobChanges.track(Promise.resolve()); return undefined; }
    let alive = true;
    // A job no longer kept is an answer; other failures leave the filter behind until reads work again.
    jobChanges.track(api.getJob(state.job).then((job) => { if (alive) setFilteredJob(job); }, (error: unknown) => {
      if (alive) setFilteredJob(null);
      if (!(error instanceof ApiError && error.code === 'job_not_found')) throw error;
    }));
    return () => { alive = false; };
  }, [state.job, jobChanges.tick]);

  function change(patch: Partial<ActivityViewState>): void {
    onState({ ...state, ...patch });
  }

  async function loadOlder(): Promise<void> {
    if (!log?.nextCursor) return;
    const requestedFilter = filter;
    const requestedCursor = log.nextCursor;
    const requestedGeneration = logGeneration.current;
    if (effectiveMode === 'summary') summaryLocked.current = true;
    setLoadingOlder(true);
    try {
      const query = filterQuery.current?.filter === filter ? filterQuery.current.query : activityQuery(state, new Date());
      const page = effectiveMode === 'summary'
        ? await api.activitySummary({ ...query, limit: LOG_PAGE, cursor: requestedCursor })
        : await api.activity({ ...query, limit: LOG_PAGE, cursor: requestedCursor });
      setLog((previous) => requestedGeneration === logGeneration.current
        && previous?.filter === requestedFilter && previous.nextCursor === requestedCursor
        ? { ...previous,
          events: [...previous.events, ...('events' in page ? page.events : [])],
          entries: [...previous.entries, ...('entries' in page ? page.entries : [])],
          nextCursor: page.nextCursor, health: page.log }
        : previous);
    } catch (error) {
      if (requestedGeneration === logGeneration.current && currentFilter.current === requestedFilter) {
        setLogError(error instanceof Error ? error.message : '無法讀取更早的記錄。');
      }
    } finally {
      if (requestedGeneration === logGeneration.current && currentFilter.current === requestedFilter) setLoadingOlder(false);
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

  if (state.group) return <ActivityGroup groupId={state.group} returnTo={state.returnTo} state={state} onState={onState} />;

  return <>
    <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>記錄</h1></div>

    <section className="activity-card log-card" aria-labelledby="activity-log" data-testid="activity-log">
      <div className="log-toolbar">
        <h2 id="activity-log">記錄</h2>
        <div className="segmented" role="group" aria-label="記錄呈現">
          <button type="button" className={effectiveMode === 'summary' ? 'active' : ''} aria-pressed={effectiveMode === 'summary'}
            onClick={() => change({ mode: 'summary' })} data-testid="activity-summary">摘要</button>
          <button type="button" className={effectiveMode === 'raw' ? 'active' : ''} aria-pressed={effectiveMode === 'raw'}
            onClick={() => change({ mode: 'raw' })} data-testid="activity-raw">完整事件</button>
        </div>
        <span className="panel-spacer" />
        <label className="source-select"><span className="visually-hidden">紀錄類型</span>
          <select value={state.recordType} onChange={(event) => change({ recordType: event.target.value as ActivityViewState['recordType'] })}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-type">
            {RECORD_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="source-select"><span className="visually-hidden">最低等級</span>
          <select value={state.minLevel} onChange={(event) => change({ minLevel: event.target.value as ActivityViewState['minLevel'] })}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-level">
            {MIN_LEVEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="source-select"><span className="visually-hidden">訂閱</span>
          <select value={state.source ?? ''} onChange={(event) => change({ source: event.target.value || null })}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-source">
            <option value="">所有訂閱</option>
            {subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.title}</option>)}
            {sourceKnown ? null : <option value={state.source!}>{state.source}</option>}
          </select>
        </label>
        <label className="source-select"><span className="visually-hidden">時間</span>
          <select value={state.range} onChange={(event) => change({ range: event.target.value as ActivityViewState['range'] })}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-range">
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
        : (effectiveMode === 'summary' ? log.entries.length : log.events.length) === 0 ? <p className="job-empty activity-pad">這段期間沒有符合的記錄。</p>
          : effectiveMode === 'summary' ? <ol className="summary-rows">{log.entries.map((entry) => entry.kind === 'event'
            ? <SummaryEvent key={entry.event.eventId} event={entry.event} />
            : <li key={entry.groupId} className={`summary-row level-${eventLevel(entry)}`} data-testid="summary-check">
              <Icon name={entry.severity === 'error' ? 'error' : 'jobs'} size={16} />
              <span><strong>{summaryCheckTitle(entry)}</strong><small>{summaryRange(entry.firstFinishedAt, entry.lastFinishedAt)}{entry.sourceTitle ? ` · ${entry.sourceTitle}` : ''}</small></span>
              <button type="button" className="inline-link" onClick={() => change({ group: entry.groupId, returnTo: '/activity' })}>查看細節</button>
            </li>)}</ol>
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
    <p className="activity-retention">保留最近 30 天{effectiveMode === 'summary' ? ' · 相同的定時檢查結果合併顯示' : ''}</p>
  </>;
}

function SummaryEvent({ event }: { event: JobEvent }) {
  const subscriptionType = event.sourceType ?? sourceDeclarations().find((declaration) => declaration.subscription)?.id;
  return <li className="summary-row" data-testid="summary-event"><Icon name="activity" size={16} />
    <span><strong>{event.documentId ? <a href={readerPath(event.documentId)}>{eventText(event)}</a>
      : event.subscriptionId && subscriptionType ? <a href={sourcePath(subscriptionType, event.subscriptionId)}>{eventText(event)}</a>
        : eventText(event)}</strong><small>{logTime(event.timestamp)}</small></span></li>;
}

function summaryCheckTitle(entry: Extract<ActivitySummaryEntry, { kind: 'check' }>): string {
  const base = entry.result === 'empty' ? `完成檢查：沒有新${itemNoun(entry.sourceType)}`
    : entry.result === 'network_error' ? '發生錯誤：網路錯誤'
      : entry.severity === 'error' ? `發生錯誤：${entry.errorCode ? failureLabel(entry.sourceType, { code: entry.errorCode, message: entry.message }) : entry.message}`
        : entry.created || entry.existing || entry.failed || entry.skipped
          ? `完成收集：${[
            ...(entry.created ? [`新增 ${itemCount(entry.sourceType, entry.created)}`] : []),
            ...(entry.existing ? [`已存在 ${itemCount(entry.sourceType, entry.existing)}`] : []),
            ...(entry.failed ? [`失敗 ${itemCount(entry.sourceType, entry.failed)}`] : []),
            ...(entry.skipped ? [`略過 ${itemCount(entry.sourceType, entry.skipped)}`] : []),
          ].join('・')}`
          : '完成收集';
  return `${base}${entry.count > 1 ? `・${entry.count} 次` : ''}`;
}

function ActivityGroup({ groupId, returnTo, state, onState }: { groupId: string; returnTo: string | null; state: ActivityViewState; onState: (next: ActivityViewState) => void }) {
  const [page, setPage] = useState<ActivityGroupPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedCount = useRef(10);
  const loadedGroup = useRef(groupId);
  const requestGeneration = useRef(0);
  const severity = activityQuery(state, new Date()).severity;
  const severityKey = severity?.join(',') ?? '';
  async function filteredChecks(target: number): Promise<ActivityGroupPage> {
    let answer = await api.activityGroup(groupId, { limit: Math.min(100, target), severity });
    while (answer.checks.length < target && answer.nextCursor) {
      const next = await api.activityGroup(groupId, {
        limit: Math.min(100, target - answer.checks.length), cursor: answer.nextCursor, severity,
      });
      answer = { ...next, checks: [...answer.checks, ...next.checks] };
    }
    return answer;
  }
  useEffect(() => {
    let alive = true;
    const generation = ++requestGeneration.current;
    if (loadedGroup.current !== groupId) { loadedGroup.current = groupId; loadedCount.current = 10; }
    setPage(null); setError(null); setLoading(false);
    filteredChecks(loadedCount.current).then((answer) => { if (alive && generation === requestGeneration.current) setPage(answer); })
      .catch((reason: unknown) => { if (alive && generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : '無法讀取檢查細節。'); });
    return () => { alive = false; };
  }, [groupId, severityKey]);
  async function older() {
    if (!page?.nextCursor) return;
    const generation = requestGeneration.current;
    const requestedSeverity = severityKey;
    const requestedCursor = page.nextCursor;
    setLoading(true);
    try {
      const next = await api.activityGroup(groupId, { limit: 10, cursor: requestedCursor, severity });
      setPage((previous) => generation === requestGeneration.current && requestedSeverity === severityKey
        && previous?.group.groupId === groupId && previous.nextCursor === requestedCursor
        ? { ...next, checks: [...previous.checks, ...next.checks] } : previous);
      if (generation === requestGeneration.current && requestedSeverity === severityKey) loadedCount.current += next.checks.length;
    } catch (reason) {
      if (generation === requestGeneration.current && requestedSeverity === severityKey) {
        setError(reason instanceof Error ? reason.message : '無法讀取更早的檢查。');
      }
    } finally {
      if (generation === requestGeneration.current && requestedSeverity === severityKey) setLoading(false);
    }
  }
  const back = () => {
    if (returnTo && sourceRouteForPath(returnTo)) { location.href = returnTo; return; }
    onState({ ...state, group: null, returnTo: null });
  };
  return <>
    <button type="button" className="back-link" onClick={back}><Icon name="back" size={15} />返回</button>
    <div className="page-header"><h1 className="page-title">記錄</h1></div>
    {error ? <p className="load-error" role="alert">{error}</p> : null}
    {!page ? (error ? null : <p className="loading">正在讀取…</p>) : <>
      <section className="activity-context" data-testid="activity-group-context"><strong>{summaryCheckTitle(page.group)}</strong>
        <span>{page.group.sourceTitle ? `${page.group.sourceTitle} · ` : ''}{summaryRange(page.group.firstFinishedAt, page.group.lastFinishedAt)} · 完整事件</span></section>
      <section className="activity-card"><div className="log-toolbar"><h2>每次收集</h2><span className="panel-spacer" />
        <label className="source-select"><span className="visually-hidden">最低等級</span><select value={state.minLevel}
          onChange={(event) => onState({ ...state, minLevel: event.target.value as ActivityViewState['minLevel'] })}
          onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
          onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
          onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="group-level">
          {MIN_LEVEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <span className="activity-group-count">{page.checks.length === page.group.count
          ? `共 ${page.group.count} 次收集` : `已顯示 ${page.checks.length} 次，共 ${page.group.count} 次收集`}</span></div>
        {page.checks.map((check, index) => <details key={check.jobId} open={index === 0} className="check-detail" data-testid="activity-group-check">
          <summary>{logTime(check.finishedAt)}　{checkResultTitle(check, page.group.sourceType)}</summary>
          {check.events.length === 0 ? <p className="job-empty activity-detail-empty">這次收集沒有符合等級的事件。</p> : <ol className="log-rows">{[...check.events].reverse().map((event) => {
            const level = eventLevel(event);
            const type = event.sourceType ? sourceDeclaration(event.sourceType) : undefined;
            return <li key={event.eventId} className={`log-row level-${level.toLowerCase()}`} data-testid="log-row"><time>{logTime(event.timestamp)}</time>
              <span className="log-level">{level}</span><span className={type ? `log-type type-${type.icon}` : 'log-type'}>
                {type ? <Icon name={type.icon} size={14} label={type.label} /> : null}</span><span>{eventText(event)}</span></li>;
          })}</ol>}
        </details>)}
        {page.nextCursor ? <div className="activity-more"><button className="button small" disabled={loading} onClick={() => void older()}>{loading ? '正在讀取…' : '載入更早的檢查'}</button></div> : null}
      </section>
    </>}
  </>;
}

function checkResultTitle(check: ActivityGroupPage['checks'][number], sourceType: string): string {
  if (check.result === 'network_error') return '發生錯誤：網路錯誤';
  if (check.result === 'empty') return `完成檢查：沒有新${itemNoun(sourceType)}`;
  if (check.errorCode) return `發生錯誤：${failureLabel(sourceType, { code: check.errorCode, message: check.message })}`;
  const parts = [
    ...(check.created ? [`新增 ${itemCount(sourceType, check.created)}`] : []),
    ...(check.existing ? [`已存在 ${itemCount(sourceType, check.existing)}`] : []),
    ...(check.failed ? [`失敗 ${itemCount(sourceType, check.failed)}`] : []),
    ...(check.skipped ? [`略過 ${itemCount(sourceType, check.skipped)}`] : []),
  ];
  return parts.length ? `完成收集：${parts.join('・')}` : '完成收集';
}

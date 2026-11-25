import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type {
  ActivityGroupPage,
  ActivityLogHealth,
  ActivitySummaryEntry,
  JobEvent,
} from '../../shared/activity/activity-types.js';
import type { JobView } from '../../shared/jobs/job-types.js';
import type { Subscription } from '../../shared/subscriptions/subscription-types.js';
import {
  activityQuery,
  activityStateSearch,
  diagnosticsText,
  eventLevel,
  eventText,
  jobBadge,
  MIN_LEVEL_OPTIONS,
  MIN_LEVELS,
  RECORD_TYPE_OPTIONS,
  RECORD_TYPES,
  logTime,
  mergeNewest,
  mergeSummary,
  parseActivityState,
  RANGE_OPTIONS,
  RANGES,
  severityAtLeast,
  summaryRange,
  type ActivityMinLevel,
  type ActivityViewState,
} from './activity-presentation.js';
import { api } from './api-client.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import { Icon } from './icons.js';
import { useChangeRead, useChanges } from './use-changes.js';
import { ActivityGroupPages, type GroupPagesState } from './activity-group-pages.js';
import { readerPath } from './document-presentation.js';
import { jobTitle } from './job-presentation.js';
import { isOneOf } from './one-of.js';
import { failureLabel, sourcePath, sourceRouteForPath } from './source-presentation.js';
import { itemCount, itemNoun } from './subscription-presentation.js';
import { useSourceDeclarations } from './source-declarations.js';

const LOG_PAGE = 50;

interface LogState {
  filter: string;
  events: JobEvent[];
  entries: ActivitySummaryEntry[];
  nextCursor: string | null;
  health: ActivityLogHealth;
}

export function Activity({ search, onState, onOpenDocument, onOpenSource, onNotice }: {
  search: string;
  onState: (next: ActivityViewState) => void;
  onOpenDocument: (id: string) => void;
  onOpenSource: (type: string, id: string) => void;
  onNotice: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const declarations = useSourceDeclarations();
  const state = parseActivityState(search);
  const effectiveMode = state.jobId ? 'raw' : state.mode;
  const filter = activityStateSearch({ ...state, mode: effectiveMode });
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [log, setLog] = useState<LogState | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [filteredJob, setFilteredJob] = useState<JobView | null>(null);
  const logGeneration = useRef(0);
  const subscriptionChanges = useChanges(['subscriptions']);
  const logChanges = useChanges(['activity']);
  const jobChanges = useChanges(['jobs']);
  const logFlight = useRef<{ filter: string; again: boolean } | null>(null);

  useChangeRead(subscriptionChanges, [], (signal) => api.listSubscriptions(signal), (outcome) => {
    if ('value' in outcome) setSubscriptions(outcome.value.subscriptions);
  });

  const currentFilter = useRef(filter);
  currentFilter.current = filter;
  useEffect(() => {
    logGeneration.current += 1;
    logFlight.current = null;
    setLog(null);
    setLogError(null);
    setLoadingOlder(false);
  }, [filter]);

  useEffect(() => {
    const requested = filter;
    if (logFlight.current?.filter === requested) { logFlight.current.again = true; return; }
    const load = (): void => {
      const flight = { filter: requested, again: false };
      logFlight.current = flight;
      void read().then(() => {
        if (logFlight.current !== flight) return;
        logFlight.current = null;
        if (flight.again) load();
      });
    };
    const read = () => {
      const query = activityQuery(state, new Date());
      return (effectiveMode === 'summary'
        ? api.activitySummary({ ...query, limit: LOG_PAGE })
        : api.activity({ ...query, limit: LOG_PAGE })).then((page) => {
        if (currentFilter.current !== requested) return;
        setLog((previous) => {
          const loaded = previous?.filter === requested ? previous : null;
          if (page.view === 'raw') {
            return loaded ? { ...loaded, events: mergeNewest(loaded.events, page.events), health: page.log }
              : { filter: requested, events: page.events, entries: [], nextCursor: page.nextCursor, health: page.log };
          }
          const merged = loaded ? mergeSummary(loaded, page) : page;
          return { filter: requested, events: [], entries: merged.entries, nextCursor: merged.nextCursor, health: page.log };
        });
        setLogError(null);
      }, (error: unknown) => {
        if (currentFilter.current === requested) setLogError(error instanceof Error ? error.message : '無法讀取記錄。');
      });
    };
    load();
  }, [filter, logChanges, effectiveMode]);

  const jobId = state.jobId;
  useChangeRead(jobChanges, [jobId], (signal) => (jobId ? api.getJob(jobId, signal) : Promise.resolve(null)), (outcome) => {
    setFilteredJob('value' in outcome ? outcome.value : null);
  });

  function change(patch: Partial<ActivityViewState>): void {
    onState({ ...state, ...patch });
  }

  async function loadOlder(): Promise<void> {
    if (!log?.nextCursor) return;
    const requestedFilter = filter;
    const requestedCursor = log.nextCursor;
    const requestedGeneration = logGeneration.current;
    setLoadingOlder(true);
    try {
      const query = activityQuery(state, new Date());
      const page = effectiveMode === 'summary'
        ? await api.activitySummary({ ...query, limit: LOG_PAGE, cursor: requestedCursor })
        : await api.activity({ ...query, limit: LOG_PAGE, cursor: requestedCursor });
      setLog((previous) => requestedGeneration === logGeneration.current
        && previous?.filter === requestedFilter && previous.nextCursor === requestedCursor
        ? { ...previous,
          events: [...previous.events, ...(page.view === 'raw' ? page.events : [])],
          entries: [...previous.entries, ...(page.view === 'summary' ? page.entries : [])],
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
      await navigator.clipboard.writeText(diagnosticsText(declarations, job, page.events));
      onNotice('已複製診斷資訊。');
    } catch {
      onNotice('無法複製診斷資訊。', 'error');
    }
  }

  const dropped = log?.health.dropped ?? 0;
  const unlistedSubscriptionId = state.subscriptionId !== null && !subscriptions.some((subscription) => subscription.id === state.subscriptionId)
    ? state.subscriptionId : null;

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
          <select value={state.recordType} onChange={(event) => { const value = event.target.value; if (isOneOf(RECORD_TYPES, value)) change({ recordType: value }); }}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-type">
            {RECORD_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="source-select"><span className="visually-hidden">最低等級</span>
          <select value={state.minLevel} onChange={(event) => { const value = event.target.value; if (isOneOf(MIN_LEVELS, value)) change({ minLevel: value }); }}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-level">
            {MIN_LEVEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="source-select"><span className="visually-hidden">訂閱</span>
          <select value={state.subscriptionId ?? ''} onChange={(event) => change({ subscriptionId: event.target.value || null })}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-source">
            <option value="">所有訂閱</option>
            {subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.title}</option>)}
            {unlistedSubscriptionId === null ? null : <option value={unlistedSubscriptionId}>{unlistedSubscriptionId}</option>}
          </select>
        </label>
        <label className="source-select"><span className="visually-hidden">時間</span>
          <select value={state.range} onChange={(event) => { const value = event.target.value; if (isOneOf(RANGES, value)) change({ range: value }); }}
            onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
            onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
            onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="log-range">
            {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {state.jobId ? <div className="log-job-filter" data-testid="log-job-filter">
        <span className="chip active">工作：{filteredJob ? `${jobBadge(declarations, filteredJob)}・${jobTitle(filteredJob)}` : '…'}
          <button type="button" className="chip-clear" aria-label="清除工作篩選" onClick={() => change({ jobId: null })}>×</button></span>
        {filteredJob ? <button type="button" className="button small" onClick={() => void copyDiagnostics(filteredJob)} data-testid="copy-diagnostics">複製診斷資訊</button> : null}
      </div> : null}
      {dropped > 0 ? <p className="log-warning" role="alert" data-testid="log-warning">有 {dropped} 筆記錄未能寫入而遺失。</p> : null}
      {logError ? <p className="load-error activity-pad" role="alert">{logError}</p> : null}
      {log === null ? <p className="job-empty activity-pad">正在讀取…</p>
        : (effectiveMode === 'summary' ? log.entries.length : log.events.length) === 0 ? <p className="job-empty activity-pad">這段期間沒有符合的記錄。</p>
          : effectiveMode === 'summary' ? <ol className="summary-rows">{log.entries.map((entry) => entry.kind === 'event'
            ? <SummaryEvent key={entry.event.eventId} event={entry.event} onOpenDocument={onOpenDocument} onOpenSource={onOpenSource} />
            : <li key={entry.groupId} className={`summary-row level-${eventLevel(entry)}`} data-testid="summary-check"
              data-group={entry.groupId} data-result={entry.result} data-count={entry.count} data-severity={entry.severity}>
              <Icon name={entry.severity === 'error' ? 'error' : 'jobs'} size={16} />
              <span><strong>{summaryCheckTitle(declarations, entry)}</strong><small>{summaryRange(entry.firstFinishedAt, entry.lastFinishedAt)}{entry.sourceTitle ? ` · ${entry.sourceTitle}` : ''}</small></span>
              <button type="button" className="inline-link" onClick={() => change({ group: entry.groupId, returnTo: '/activity' })}>查看細節</button>
            </li>)}</ol>
          : <ol className="log-rows">{log.events.map((event) => {
            const level = eventLevel(event);
            const text = eventText(declarations, event);
            const type = event.sourceType ? declarations.get(event.sourceType) : undefined;
            return <li key={event.eventId} className={`log-row level-${level.toLowerCase()}`} data-testid="log-row"
              data-event-type={event.eventType} data-severity={event.severity}>
              <time dateTime={event.timestamp}>{logTime(event.timestamp)}</time>
              <span className="log-level">{level}</span>
              <span className={type ? `log-type type-${type.icon}` : 'log-type'}>
                {type ? <Icon name={type.icon} size={14} label={type.label} /> : null}
              </span>
              <EventLink event={event} text={text} onOpenDocument={onOpenDocument} onOpenSource={onOpenSource} fallback={<span>{text}</span>} />
            </li>;
          })}</ol>}
      {log?.nextCursor ? <div className="activity-more"><button type="button" className="button small" disabled={loadingOlder} onClick={() => void loadOlder()} data-testid="load-older">
        {loadingOlder ? '正在讀取…' : '載入更早的記錄'}</button></div> : null}
    </section>
    <p className="activity-retention">保留最近 30 天{effectiveMode === 'summary' ? ' · 相同的定時檢查結果合併顯示' : ''}</p>
  </>;
}

interface EventNavigation {
  onOpenDocument: (id: string) => void;
  onOpenSource: (type: string, id: string) => void;
}

function SummaryEvent({ event, onOpenDocument, onOpenSource }: { event: JobEvent } & EventNavigation) {
  const declarations = useSourceDeclarations();
  const text = eventText(declarations, event);
  return <li className="summary-row" data-testid="summary-event" data-event-type={event.eventType} data-severity={event.severity}><Icon name="activity" size={16} />
    <span><strong><EventLink event={event} text={text} onOpenDocument={onOpenDocument} onOpenSource={onOpenSource} fallback={text} /></strong>
      <small>{logTime(event.timestamp)}</small></span></li>;
}

function EventLink({ event, text, fallback, onOpenDocument, onOpenSource }: { event: JobEvent; text: string; fallback: ReactNode } & EventNavigation) {
  const { documentId, subscriptionId, sourceType } = event;
  if (documentId) return <a href={readerPath(documentId)} onClick={(click) => openInApp(click, () => onOpenDocument(documentId))}>{text}</a>;
  if (subscriptionId && sourceType) {
    return <a href={sourcePath(sourceType, subscriptionId)} onClick={(click) => openInApp(click, () => onOpenSource(sourceType, subscriptionId))}>{text}</a>;
  }
  return <>{fallback}</>;
}

function openInApp(event: MouseEvent, action: () => void): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  action();
}

function summaryCheckTitle(declarations: SourceDeclarations, entry: Extract<ActivitySummaryEntry, { kind: 'check' }>): string {
  const base = entry.result === 'empty' ? `完成檢查：沒有新${itemNoun(declarations, entry.sourceType)}`
    : entry.result === 'network_error' ? '發生錯誤：網路錯誤'
      : entry.severity === 'error' ? `發生錯誤：${entry.errorCode ? failureLabel(declarations, entry.sourceType, { code: entry.errorCode, message: entry.message }) : entry.message}`
        : entry.created || entry.existing || entry.failed || entry.skipped
          ? `完成收集：${[
            ...(entry.created ? [`新增 ${itemCount(declarations, entry.sourceType, entry.created)}`] : []),
            ...(entry.existing ? [`已存在 ${itemCount(declarations, entry.sourceType, entry.existing)}`] : []),
            ...(entry.failed ? [`失敗 ${itemCount(declarations, entry.sourceType, entry.failed)}`] : []),
            ...(entry.skipped ? [`略過 ${itemCount(declarations, entry.sourceType, entry.skipped)}`] : []),
          ].join('・')}`
          : '完成收集';
  return `${base}${entry.count > 1 ? `・${entry.count} 次` : ''}`;
}

function ActivityGroup({ groupId, returnTo, state, onState }: { groupId: string; returnTo: string | null; state: ActivityViewState; onState: (next: ActivityViewState) => void }) {
  const declarations = useSourceDeclarations();
  const { page, error, loading, older } = useActivityGroupPages(groupId, state.minLevel);
  const back = () => {
    if (returnTo && sourceRouteForPath(returnTo)) { location.href = returnTo; return; }
    onState({ ...state, group: null, returnTo: null });
  };
  return <>
    <button type="button" className="back-link" onClick={back}><Icon name="back" size={15} />返回</button>
    <div className="page-header"><h1 className="page-title">記錄</h1></div>
    {error ? <p className="load-error" role="alert">{error}</p> : null}
    {!page ? (error ? null : <p className="loading">正在讀取…</p>) : <>
      <section className="activity-context" data-testid="activity-group-context"
        data-group={page.group.groupId} data-count={page.group.count} data-loaded={page.checks.length}><strong>{summaryCheckTitle(declarations, page.group)}</strong>
        <span>{page.group.sourceTitle ? `${page.group.sourceTitle} · ` : ''}{summaryRange(page.group.firstFinishedAt, page.group.lastFinishedAt)} · 完整事件</span></section>
      <section className="activity-card"><div className="log-toolbar"><h2>每次收集</h2><span className="panel-spacer" />
        <label className="source-select"><span className="visually-hidden">最低等級</span><select value={state.minLevel}
          onChange={(event) => { const value = event.target.value; if (isOneOf(MIN_LEVELS, value)) onState({ ...state, minLevel: value }); }}
          onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
          onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
          onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="group-level">
          {MIN_LEVEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <span className="activity-group-count">{page.checks.length === page.group.count
          ? `共 ${page.group.count} 次收集` : `已顯示 ${page.checks.length} 次，共 ${page.group.count} 次收集`}</span></div>
        {page.checks.map((check, index) => <details key={check.jobId} open={index === 0} className="check-detail" data-testid="activity-group-check"
          data-job={check.jobId} data-result={check.result} data-events={check.events.length}>
          <summary>{logTime(check.finishedAt)}　{checkResultTitle(declarations, check, page.group.sourceType)}</summary>
          {check.events.length === 0 ? <p className="job-empty activity-detail-empty">這次收集沒有符合等級的事件。</p> : <ol className="log-rows">{[...check.events].reverse().map((event) => {
            const level = eventLevel(event);
            const type = event.sourceType ? declarations.get(event.sourceType) : undefined;
            return <li key={event.eventId} className={`log-row level-${level.toLowerCase()}`} data-testid="log-row"
              data-event-type={event.eventType} data-severity={event.severity}><time>{logTime(event.timestamp)}</time>
              <span className="log-level">{level}</span><span className={type ? `log-type type-${type.icon}` : 'log-type'}>
                {type ? <Icon name={type.icon} size={14} label={type.label} /> : null}</span><span>{eventText(declarations, event)}</span></li>;
          })}</ol>}
        </details>)}
        {page.nextCursor ? <div className="activity-more"><button className="button small" disabled={loading} onClick={() => void older()}>{loading ? '正在讀取…' : '載入更早的檢查'}</button></div> : null}
      </section>
    </>}
  </>;
}

function checkResultTitle(declarations: SourceDeclarations, check: ActivityGroupPage['checks'][number], sourceType: string): string {
  if (check.result === 'network_error') return '發生錯誤：網路錯誤';
  if (check.result === 'empty') return `完成檢查：沒有新${itemNoun(declarations, sourceType)}`;
  if (check.errorCode) return `發生錯誤：${failureLabel(declarations, sourceType, { code: check.errorCode, message: check.message })}`;
  const parts = [
    ...(check.created ? [`新增 ${itemCount(declarations, sourceType, check.created)}`] : []),
    ...(check.existing ? [`已存在 ${itemCount(declarations, sourceType, check.existing)}`] : []),
    ...(check.failed ? [`失敗 ${itemCount(declarations, sourceType, check.failed)}`] : []),
    ...(check.skipped ? [`略過 ${itemCount(declarations, sourceType, check.skipped)}`] : []),
  ];
  return parts.length ? `完成收集：${parts.join('・')}` : '完成收集';
}

function useActivityGroupPages(groupId: string, minLevel: ActivityMinLevel): GroupPagesState & { older: () => Promise<void> } {
  const [state, setState] = useState<GroupPagesState>({ page: null, error: null, loading: false });
  const [pages] = useState(() => new ActivityGroupPages((id, query) => api.activityGroup(id, query), setState));
  useEffect(() => {
    void pages.show(groupId, [...severityAtLeast(minLevel)]);
    return () => pages.close();
  }, [groupId, minLevel]);
  return { ...state, older: () => pages.older() };
}

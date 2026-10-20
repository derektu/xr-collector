import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { isRetryable, type ActivityLogHealth, type ActivityQuery, type CollectionJob, type JobEvent, type JobSummary, type Subscription } from '../core/types.js';
import {
  activityQuery,
  activityStateSearch,
  diagnosticsText,
  eventLevel,
  eventText,
  jobBadge,
  jobStatusText,
  LEVEL_OPTIONS,
  localDayStart,
  logTime,
  logWarning,
  mergeNewest,
  parseActivityState,
  RANGE_OPTIONS,
  summaryLabel,
  type ActivityViewState,
} from './activity-presentation.js';
import { api } from './api-client.js';
import { ACTIVE_POLL_MS } from './use-collection-status.js';
import { readerPath } from './document-presentation.js';
import { jobTitle } from './job-presentation.js';
import { shortTimeLabel, sourcePath } from './source-presentation.js';

const RECENT_STEP = 8;
const LOG_PAGE = 50;

interface LogState {
  filter: string;
  events: JobEvent[];
  nextCursor: string | null;
  health: ActivityLogHealth;
}

/**
 * Jobs on top (running ones with progress, recent finished ones with retry for failures) and the
 * persistent log below, filtered by level, source, time and job. Filters live in the address so
 * other pages can open the log already filtered.
 */
export function Activity({ revision, search, onState, onOpenDocument, onOpenSource, onChanged }: {
  revision: number;
  search: string;
  onState: (next: ActivityViewState) => void;
  onOpenDocument: (id: string) => void;
  onOpenSource: (type: string, id: string) => void;
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const state = parseActivityState(search);
  const filter = activityStateSearch(state);
  const [active, setActive] = useState<CollectionJob[] | null>(null);
  const [recent, setRecent] = useState<{ jobs: CollectionJob[]; more: boolean } | null>(null);
  const [recentLimit, setRecentLimit] = useState(RECENT_STEP);
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [log, setLog] = useState<LogState | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [filteredJob, setFilteredJob] = useState<CollectionJob | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const logSection = useRef<HTMLElement>(null);
  // The shell's status poll can miss a job that starts and ends between two polls, such as one an
  // Agent submitted; while this page shows work in progress, it refreshes itself as well.
  const [tick, setTick] = useState(0);
  const refresh = `${revision}:${tick}`;
  useEffect(() => {
    if (!active || active.length === 0) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), ACTIVE_POLL_MS);
    return () => clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      api.listJobs({ state: 'active', limit: 100 }, signal),
      api.listJobs({ limit: Math.min(100, recentLimit + 20) }, signal),
      api.jobSummary(localDayStart(new Date()).toISOString(), signal),
    ]).then(([activePage, recentPage, counts]) => {
      const finished = recentPage.jobs.filter((job) => job.state !== 'queued' && job.state !== 'running');
      setActive(activePage.jobs);
      setRecent({ jobs: finished.slice(0, recentLimit), more: finished.length > recentLimit || recentPage.nextCursor !== null });
      setSummary(counts);
      setJobsError(null);
    }).catch((error: unknown) => {
      if (!signal.aborted) setJobsError(error instanceof Error ? error.message : '無法讀取收集工作。');
    });
    return () => controller.abort();
  }, [refresh, recentLimit]);

  useEffect(() => {
    const controller = new AbortController();
    api.listChannels(controller.signal).then(setSubscriptions).catch(() => undefined);
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

  function showJob(id: string): void {
    change({ job: id });
    requestAnimationFrame(() => logSection.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
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

  async function retry(job: CollectionJob): Promise<void> {
    setRetrying(job.id);
    try {
      const submission = await api.retryJob(job.id);
      onChanged(submission.deduplicated ? `「${jobTitle(job)}」已有進行中的工作。` : `已重新排入「${jobTitle(job)}」。`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '無法重試這個工作。', 'error');
    } finally {
      setRetrying(null);
    }
  }

  async function copyDiagnostics(job: CollectionJob): Promise<void> {
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
  const jobs = [...(active ?? []), ...(recent?.jobs ?? [])];

  return <>
    <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>記錄</h1></div>

    <section className="activity-card" aria-labelledby="activity-jobs" data-testid="activity-jobs">
      <div className="activity-card-heading">
        <h2 id="activity-jobs">工作</h2>
        {summary ? <span className="muted" data-testid="job-summary">{summaryLabel(summary)}</span> : null}
      </div>
      {jobsError ? <p className="load-error activity-pad" role="alert">{jobsError}</p> : null}
      {active === null || recent === null ? <p className="job-empty activity-pad">正在讀取…</p>
        : jobs.length === 0 ? <p className="job-empty activity-pad">還沒有收集工作。</p>
          : <ul className="activity-jobs">{jobs.map((job) => <JobRow key={job.id} job={job} retrying={retrying === job.id}
            onShow={() => showJob(job.id)} onRetry={() => void retry(job)} />)}</ul>}
      {recent?.more ? <div className="activity-more"><button type="button" className="button small" onClick={() => setRecentLimit((limit) => limit + RECENT_STEP)}>載入更多工作</button></div> : null}
    </section>

    <section className="activity-card log-card" aria-labelledby="activity-log" ref={logSection} data-testid="activity-log">
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
            return <li key={event.eventId} className={`log-row level-${level.toLowerCase()}`} data-testid="log-row">
              <time dateTime={event.timestamp}>{logTime(event.timestamp)}</time>
              <span className="log-level">{level}</span>
              {documentId
                ? <a href={readerPath(documentId)} onClick={(click) => open(click, () => onOpenDocument(documentId))}>{text}</a>
                : subscriptionId
                  ? <a href={sourcePath('youtube', subscriptionId)} onClick={(click) => open(click, () => onOpenSource('youtube', subscriptionId))}>{text}</a>
                  : <span>{text}</span>}
            </li>;
          })}</ol>}
      {log?.nextCursor ? <div className="activity-more"><button type="button" className="button small" disabled={loadingOlder} onClick={() => void loadOlder()} data-testid="load-older">
        {loadingOlder ? '正在讀取…' : '載入更早的記錄'}</button></div> : null}
    </section>
  </>;
}

function JobRow({ job, retrying, onShow, onRetry }: { job: CollectionJob; retrying: boolean; onShow: () => void; onRetry: () => void }) {
  const running = job.state === 'queued' || job.state === 'running';
  const retryable = isRetryable(job);
  const progress = job.progress;
  return <li className={`activity-job ${job.state}`} data-testid={`job-${job.id}`}>
    <div className="activity-job-main">
      <span className="job-kind">{jobBadge(job)}</span>
      <span className="job-title" title={job.source.url}>{jobTitle(job)}</span>
      <span className={`activity-job-status ${job.state}`}>{jobStatusText(job)}</span>
      <span className="activity-job-actions">
        {running ? null : <span className="muted">{shortTimeLabel(job.finishedAt ?? job.updatedAt)}</span>}
        {retryable && job.retriedBy ? <span className="muted">已重試</span> : null}
        <button type="button" className="button small" onClick={onShow} data-testid="show-log">查看記錄</button>
        {retryable && !job.retriedBy ? <button type="button" className="button small" disabled={retrying} onClick={onRetry} data-testid="retry-job">重試</button> : null}
      </span>
    </div>
    {running && progress && progress.total > 0
      ? <progress value={progress.done} max={progress.total} aria-label={`${jobTitle(job)}進度`} /> : null}
    {job.activityIncomplete ? <p className="job-detail job-problem">部分記錄未能寫入。</p> : null}
  </li>;
}

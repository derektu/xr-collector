import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CollectionJob } from '../core/types.js';
import { api } from './api-client.js';
import {
  hasActiveJobs,
  jobKindLabel,
  jobPhaseLabel,
  jobProgressLabel,
  jobResultLabel,
  jobStateLabel,
  jobTitle,
  youtubeSubmitAction,
} from './job-presentation.js';

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;

/** URL entry and the collection jobs of the active Vault. Jobs live in the service, so leaving the page loses nothing. */
export function YouTubeSource() {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [jobs, setJobs] = useState<CollectionJob[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => undefined);
  const action = youtubeSubmitAction(url);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let sequence = 0;
    const load = async () => {
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const current = ++sequence;
      let delay = IDLE_POLL_MS;
      try {
        const page = await api.listJobs({ limit: 20 }, controller.signal);
        // A slower earlier response must not replace a newer list.
        if (!active || current !== sequence) return;
        setJobs(page.jobs);
        setLoadError(null);
        if (hasActiveJobs(page.jobs)) delay = ACTIVE_POLL_MS;
      } catch (error) {
        if (!active || current !== sequence) return;
        setLoadError(error instanceof Error ? error.message : '無法讀取收集工作。');
      }
      timer = setTimeout(() => void load(), delay);
    };
    refresh.current = () => void load();
    void load();
    return () => { active = false; clearTimeout(timer); controller?.abort(); };
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!action.enabled || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const submission = await api.submitYouTube(url);
      setNotice({
        tone: 'ok',
        text: submission.deduplicated
          ? `這個項目已在處理中，沿用同一個工作：${jobTitle(submission.job)}`
          : `已接受${jobKindLabel(submission.job)}工作，可以繼續其他操作。`,
      });
      setUrl('');
      refresh.current();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '無法送出，請稍後再試。' });
    } finally {
      setSubmitting(false);
    }
  }

  return <section className="youtube-source" aria-label="YouTube 來源" data-testid="source-view-youtube">
    <h3>YouTube</h3>
    <form className="url-entry" onSubmit={(event) => void submit(event)}>
      <label className="visually-hidden" htmlFor="youtube-url">YouTube 網址</label>
      <input id="youtube-url" type="text" value={url} placeholder="貼上影片網址或頻道網址 / @handle…" autoComplete="off" spellCheck={false}
        aria-describedby="youtube-url-help" onChange={(event) => { setUrl(event.target.value); setNotice(null); }} />
      <button type="submit" disabled={!action.enabled || submitting}>{submitting ? '送出中…' : action.label}</button>
    </form>
    {action.reason ? <p className="url-reason" role="status">{action.reason}</p> : null}
    {notice ? <p className={`url-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
    <p className="url-help" id="youtube-url-help">貼上影片網址，將字幕內容加入知識庫。貼上頻道網址或 @handle，會加入頻道並收集最近 10 支影片。</p>
    <JobList jobs={jobs} loadError={loadError} />
  </section>;
}

function JobList({ jobs, loadError }: { jobs: CollectionJob[] | null; loadError: string | null }) {
  return <section className="job-list" aria-label="收集工作">
    <div className="job-list-heading"><h4>收集工作</h4>{loadError ? <span className="job-load-error" role="alert">{loadError}</span> : null}</div>
    {jobs === null ? <p className="job-empty">正在讀取…</p> : jobs.length === 0 ? <p className="job-empty">還沒有收集工作。</p>
      : <ul>{jobs.map((job) => <JobRow key={job.id} job={job} />)}</ul>}
  </section>;
}

function JobRow({ job }: { job: CollectionJob }) {
  const phase = jobPhaseLabel(job);
  const progress = jobProgressLabel(job);
  const result = jobResultLabel(job);
  const warning = job.state === 'completed' && job.result?.indexed === false;
  return <li className={`job-row ${job.state}`} data-testid={`job-${job.id}`}>
    <div className="job-main">
      <span className="job-kind">{jobKindLabel(job)}</span>
      <span className="job-title" title={job.source.url}>{jobTitle(job)}</span>
      <span className={`job-state ${job.state}`}>{jobStateLabel(job)}{phase ? `・${phase}` : ''}</span>
    </div>
    {progress ? <p className="job-detail">{progress}</p> : null}
    {result ? <p className={`job-detail ${warning || job.state !== 'completed' ? 'job-problem' : ''}`}>{result}</p> : null}
    {job.items && job.items.length > 0 ? <details className="job-items"><summary>查看影片（{job.items.length}）</summary><ul>
      {job.items.map((item) => <li key={item.sourceId}><span>{item.title}</span><span className={`job-state ${item.state}`}>{item.outcome === 'created' ? '新增' : item.outcome === 'existing' ? '已存在' : jobStateLabel({ ...job, state: item.state })}</span>{item.error ? <span className="job-problem">{item.error.message}</span> : null}</li>)}
    </ul></details> : null}
  </li>;
}

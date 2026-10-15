import { useEffect, useState } from 'react';
import type { CollectionJob } from '../core/types.js';
import { api } from './api-client.js';
import {
  jobItemLabel,
  jobKindLabel,
  jobPhaseLabel,
  jobProgressLabel,
  jobResultLabel,
  jobStateLabel,
  jobTitle,
  recoveryLabel,
  retryLabel,
} from './job-presentation.js';

/** Recent collection jobs of the active Vault, newest first; reloads whenever background work changes. */
export function Activity({ revision }: { revision: number }) {
  const [jobs, setJobs] = useState<CollectionJob[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.listJobs({ limit: 20 }, controller.signal).then((page) => { setJobs(page.jobs); setLoadError(null); }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '無法讀取收集工作。');
    });
    return () => controller.abort();
  }, [revision]);

  return <>
    <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>活動</h1></div>
    <JobList jobs={jobs} loadError={loadError} />
  </>;
}

function JobList({ jobs, loadError }: { jobs: CollectionJob[] | null; loadError: string | null }) {
  return <section className="job-list" aria-label="收集工作">
    {loadError ? <p className="load-error" role="alert">{loadError}</p> : null}
    {jobs === null ? <p className="job-empty">正在讀取…</p> : jobs.length === 0 ? <p className="job-empty">還沒有收集工作。</p>
      : <ul>{jobs.map((job) => <JobRow key={job.id} job={job} />)}</ul>}
  </section>;
}

function JobRow({ job }: { job: CollectionJob }) {
  const phase = jobPhaseLabel(job);
  const progress = jobProgressLabel(job);
  const result = jobResultLabel(job);
  const retry = retryLabel(job.retry);
  const recovery = recoveryLabel(job);
  const warning = job.state === 'completed' && job.result?.indexed === false;
  return <li className={`job-row ${job.state}`} data-testid={`job-${job.id}`}>
    <div className="job-main">
      <span className="job-kind">{jobKindLabel(job)}</span>
      <span className="job-title" title={job.source.url}>{jobTitle(job)}</span>
      <span className={`job-state ${job.state}`}>{jobStateLabel(job)}{phase ? `・${phase}` : ''}</span>
    </div>
    {progress ? <p className="job-detail">{progress}</p> : null}
    {retry ? <p className="job-detail job-problem" data-testid="job-retry">{retry}</p> : null}
    {recovery ? <p className="job-detail job-note" data-testid="job-recovery">{recovery}</p> : null}
    {result ? <p className={`job-detail ${warning || job.state !== 'completed' ? 'job-problem' : ''}`}>{result}</p> : null}
    {job.items && job.items.length > 0 ? <details className="job-items"><summary>查看影片（{job.items.length}）</summary><ul>
      {job.items.map((item) => <li key={item.sourceId}><span>{item.title}</span><span className={`job-state ${item.state}`}>{jobItemLabel(item)}</span>{item.error ? <span className="job-problem">{item.error.message}</span> : null}</li>)}
    </ul></details> : null}
  </li>;
}

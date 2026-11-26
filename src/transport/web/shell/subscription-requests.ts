import type { JobView } from '../../../shared/jobs/job-types.js';

interface SentJob { id: string; kind: string }

export interface SubscriptionRequests {
  sent(response: unknown, isSubscription: (kind: string) => boolean): void;
  activeListRead(active: readonly Pick<JobView, 'id'>[], getJob: (id: string) => Promise<JobView>, failed: (job: JobView) => void): Promise<void>;
}

function sentJob(response: unknown): SentJob | null {
  if (typeof response !== 'object' || response === null || !('job' in response)) return null;
  const job = response.job;
  if (typeof job !== 'object' || job === null || !('id' in job) || !('kind' in job)) return null;
  return typeof job.id === 'string' && typeof job.kind === 'string' ? { id: job.id, kind: job.kind } : null;
}

export function trackSubscriptionRequests(): SubscriptionRequests {
  const pending = new Set<string>();
  return {
    sent(response, isSubscription) {
      const job = sentJob(response);
      if (job && isSubscription(job.kind)) pending.add(job.id);
    },
    async activeListRead(active, getJob, failed) {
      const current = new Set(active.map((job) => job.id));
      const left = [...pending].filter((id) => !current.has(id));
      for (const id of left) pending.delete(id);
      await Promise.all(left.map((id) => getJob(id).then((job) => {
        if (job.state === 'queued' || job.state === 'running') pending.add(id);
        else if (job.state === 'failed') failed(job);
      }).catch(() => undefined)));
    },
  };
}

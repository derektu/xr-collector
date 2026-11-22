import { useEffect, useState } from 'react';
import type { CollectionScheduleView } from '../../shared/subscriptions/subscription-types.js';
import type { JobView } from '../../shared/jobs/job-types.js';
import { api } from './api-client.js';
import { activeJobs } from './source-presentation.js';
import { useChanges } from './use-changes.js';

export interface CollectionStatus {
  active: JobView[] | null;
  schedule: CollectionScheduleView | null;
}

export function useCollectionStatus(enabled: boolean): CollectionStatus {
  const [status, setStatus] = useState<CollectionStatus>({ active: null, schedule: null });
  const { tick, track } = useChanges(['activeJobs', 'schedule']);

  useEffect(() => {
    if (!enabled) { track(Promise.resolve()); return undefined; }
    let alive = true;
    track(Promise.all([api.listJobs({ state: 'active', limit: 100 }), api.getSchedule()]).then(([page, schedule]) => {
      if (alive) setStatus({ active: activeJobs(page.jobs), schedule });
    }));
    return () => { alive = false; };
  }, [enabled, tick]);
  return status;
}

import { useEffect, useState } from 'react';
import type { CollectionScheduleView, JobView } from '../core/types.js';
import { api } from './api-client.js';
import { activeJobs } from './source-presentation.js';
import { useChanges } from './use-changes.js';

export interface CollectionStatus {
  /** Top-level jobs still queued or running; null until the first load. */
  active: JobView[] | null;
  schedule: CollectionScheduleView | null;
}

/** Background collection as the whole shell sees it: active jobs and the schedule summary, read again after each change to them. */
export function useCollectionStatus(enabled: boolean): CollectionStatus {
  const [status, setStatus] = useState<CollectionStatus>({ active: null, schedule: null });
  const { tick, track } = useChanges(['activeJobs', 'schedule']);

  useEffect(() => {
    if (!enabled) { track(Promise.resolve()); return undefined; }
    let alive = true;
    // The pages report their own load errors; the shell keeps its last known state.
    track(Promise.all([api.listJobs({ state: 'active', limit: 100 }), api.getSchedule()]).then(([page, schedule]) => {
      if (alive) setStatus({ active: activeJobs(page.jobs), schedule });
    }));
    return () => { alive = false; };
  }, [enabled, tick]);
  return status;
}

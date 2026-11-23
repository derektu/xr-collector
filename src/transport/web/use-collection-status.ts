import { useState } from 'react';
import type { CollectionScheduleView } from '../../shared/subscriptions/subscription-types.js';
import type { JobView } from '../../shared/jobs/job-types.js';
import { api } from './api-client.js';
import { activeJobs } from './source-presentation.js';
import { useChangeRead, useChanges } from './use-changes.js';

export interface CollectionStatus {
  active: JobView[] | null;
  schedule: CollectionScheduleView | null;
}

export function useCollectionStatus(enabled: boolean): CollectionStatus {
  const [status, setStatus] = useState<CollectionStatus>({ active: null, schedule: null });
  const tick = useChanges(['activeJobs', 'schedule']);

  useChangeRead(tick, [], (signal) => Promise.all([api.listJobs({ state: 'active', limit: 100 }, signal), api.getSchedule()]), (outcome) => {
    if ('value' in outcome) setStatus({ active: activeJobs(outcome.value[0].jobs), schedule: outcome.value[1] });
  }, enabled);
  return status;
}

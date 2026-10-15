import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelSchedule, CollectionJob } from '../core/types.js';
import { api } from './api-client.js';
import { activeJobs } from './source-presentation.js';

export const ACTIVE_POLL_MS = 1500;
export const IDLE_POLL_MS = 10_000;

export interface CollectionStatus {
  /** Top-level jobs still queued or running; null until the first load. */
  active: CollectionJob[] | null;
  schedule: ChannelSchedule | null;
  /** Increases whenever the active jobs change or a change is announced, so pages know to reload. */
  revision: number;
}

/**
 * Background collection as the whole shell sees it: active jobs and the shared schedule, polled
 * quickly while something runs and slowly otherwise. `announce` reloads at once after the UI
 * itself started or changed work.
 */
export function useCollectionStatus(enabled: boolean): CollectionStatus & { announce: () => void } {
  const [status, setStatus] = useState<CollectionStatus>({ active: null, schedule: null, revision: 0 });
  const reload = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let lastKey = '';
    const load = async () => {
      clearTimeout(timer);
      const current = ++sequence;
      let delay = IDLE_POLL_MS;
      try {
        const [page, schedule] = await Promise.all([api.listJobs({ state: 'active', limit: 100 }), api.getChannelSchedule()]);
        if (!alive || current !== sequence) return;
        const active = activeJobs(page.jobs);
        const key = JSON.stringify([active.map((job) => [job.id, job.state, job.progress?.done]), schedule.lastAttemptAt, schedule.enabled]);
        const changed = key !== lastKey;
        lastKey = key;
        setStatus((previous) => ({ active, schedule, revision: changed ? previous.revision + 1 : previous.revision }));
        if (active.length > 0) delay = ACTIVE_POLL_MS;
      } catch {
        // The pages report their own load errors; the shell keeps its last known state.
      }
      if (alive) timer = setTimeout(() => void load(), delay);
    };
    reload.current = () => void load();
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [enabled]);

  const announce = useCallback(() => {
    setStatus((previous) => ({ ...previous, revision: previous.revision + 1 }));
    reload.current();
  }, []);
  return { ...status, announce };
}

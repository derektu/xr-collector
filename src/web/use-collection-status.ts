import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollectionSchedule, JobView } from '../core/types.js';
import { api } from './api-client.js';
import { activeJobs } from './source-presentation.js';

export const ACTIVE_POLL_MS = 1500;
export const IDLE_POLL_MS = 2000;

export interface CollectionStatus {
  /** Top-level jobs still queued or running; null until the first load. */
  active: JobView[] | null;
  schedule: CollectionSchedule | null;
  /** Increases whenever the active jobs change or a change is announced, so pages know to reload. */
  revision: number;
  /** Increases when a job ends or a channel job finishes one of its videos: the moments documents can appear. */
  documentsRevision: number;
}

/**
 * Background collection as the whole shell sees it: active jobs and the schedule summary, polled
 * quickly while something runs and slowly otherwise. `announce` reloads at once after the UI
 * itself started or changed work.
 */
export function useCollectionStatus(enabled: boolean): CollectionStatus & { announce: () => void } {
  const [status, setStatus] = useState<CollectionStatus>({ active: null, schedule: null, revision: 0, documentsRevision: 0 });
  const reload = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let lastKey = '';
    let lastDocumentsKey: string | null = null;
    const load = async () => {
      clearTimeout(timer);
      const current = ++sequence;
      let delay = IDLE_POLL_MS;
      try {
        const [page, schedule] = await Promise.all([api.listJobs({ state: 'active', limit: 100 }), api.getSchedule()]);
        if (!alive || current !== sequence) return;
        const active = activeJobs(page.jobs);
        // Waits, retries and videos starting change a subscription's status between queued and
        // updating; the next check time changes its scheduled time.
        const key = JSON.stringify([
          active.map((job) => [job.id, job.state, job.progress?.done, job.wait?.until, job.retry?.nextAttemptAt,
            job.items?.filter((item) => item.wait || item.retry?.nextAttemptAt).length,
            job.items?.filter((item) => item.state === 'running').length]),
          schedule.lastCheck?.at, schedule.nextCheck?.at, schedule.enabled,
        ]);
        const changed = key !== lastKey;
        lastKey = key;
        const documentsKey = JSON.stringify(active.map((job) => [job.id, job.progress?.done]));
        const documentsChanged = lastDocumentsKey !== null && documentsKey !== lastDocumentsKey;
        lastDocumentsKey = documentsKey;
        setStatus((previous) => ({
          active, schedule,
          revision: changed ? previous.revision + 1 : previous.revision,
          documentsRevision: documentsChanged ? previous.documentsRevision + 1 : previous.documentsRevision,
        }));
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

import { ActivityLog, type ActivityLogOptions } from '../activity/activity-log.js';
import { ActivityViews } from '../activity/activity-views.js';
import type { NoteChange } from '../core/change-feed.js';
import type { SourceDeclarations } from '../core/source-registry.js';
import { JobStore } from '../jobs/job-store.js';

/**
 * The device's job record and activity log, side by side in one profile directory. Each knows only
 * its own data; this is where they meet: the log's events get the titles their jobs learned later, a
 * job whose events the log dropped is marked incomplete, and every recorded event is a change
 * readers hear about.
 */
export interface JobRecords {
  jobs: JobStore;
  activity: ActivityLog;
  views: ActivityViews;
  /** Writes the waiting events, then the jobs. */
  close(): Promise<void>;
}

export interface JobRecordsOptions extends Pick<ActivityLogOptions, 'setTimer' | 'append'> {
  now?: () => Date;
  /** Hears every job change and every recorded event once readers can see it. */
  noteChange?: NoteChange;
}

/**
 * Opens the records in `directory`: the activity log first, so the job store records the jobs a
 * stopped process left unfinished into it.
 */
export async function openJobRecords(directory: string, sources: SourceDeclarations, options: JobRecordsOptions = {}): Promise<JobRecords> {
  let jobs: JobStore | null = null;
  const activity = await ActivityLog.open(directory, activityOptions(options, () => jobs));
  jobs = await JobStore.open(directory, sources, activity, options.now, options.noteChange);
  return records(jobs, activity);
}

/** Records kept in memory; for tests and runtimes without a device profile. */
export function memoryJobRecords(sources: SourceDeclarations, options: Pick<JobRecordsOptions, 'now' | 'noteChange'> = {}): JobRecords {
  let jobs: JobStore | null = null;
  const activity = ActivityLog.memory(activityOptions(options, () => jobs));
  jobs = JobStore.memory(sources, activity, options.now, options.noteChange);
  return records(jobs, activity);
}

function activityOptions(options: JobRecordsOptions, jobs: () => JobStore | null): ActivityLogOptions {
  const { noteChange, ...log } = options;
  return {
    ...log,
    onDropped: (event) => { if (event.jobId) jobs()?.noteActivityLost(event.jobId); },
    onRecorded: () => noteChange?.({ kind: 'activity' }),
  };
}

function records(jobs: JobStore, activity: ActivityLog): JobRecords {
  return {
    jobs, activity,
    views: new ActivityViews(activity, { sourceTitle: (id) => jobs.sourceTitle(id) }),
    close: async () => {
      await activity.close();
      await jobs.close();
    },
  };
}

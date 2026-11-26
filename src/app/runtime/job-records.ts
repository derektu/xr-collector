import { ActivityLog, ActivityViews, type ActivityLogOptions } from '../../domain/activity/index.js';
import type { NoteChange } from '../../shared/api/changes.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import { JobStore } from '../../domain/jobs/index.js';

export interface JobRecords {
  jobs: JobStore;
  activity: ActivityLog;
  views: ActivityViews;
  close(): Promise<void>;
}

export interface JobRecordsOptions extends Pick<ActivityLogOptions, 'timers' | 'append'> {
  now?: () => Date;
  noteChange?: NoteChange;
}

export async function openJobRecords(directory: string, sources: SourceDeclarations, options: JobRecordsOptions = {}): Promise<JobRecords> {
  const activity = await ActivityLog.open(directory, activityOptions(options));
  return records(await JobStore.open(directory, sources, activity, options.now, options.noteChange), activity);
}

export function memoryJobRecords(sources: SourceDeclarations, options: Pick<JobRecordsOptions, 'now' | 'noteChange'> = {}): JobRecords {
  const activity = ActivityLog.memory(activityOptions(options));
  return records(JobStore.memory(sources, activity, options.now, options.noteChange), activity);
}

function activityOptions(options: JobRecordsOptions): ActivityLogOptions {
  const { noteChange, ...log } = options;
  return { ...log, onRecorded: () => noteChange?.({ kind: 'activity' }) };
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

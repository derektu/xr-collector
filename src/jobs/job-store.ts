import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ActivityLog, type ActivityLogOptions } from '../activity/activity-log.js';
import type { CollectionJob, JobEvent, JobStopKind } from '../core/types.js';

const JOBS_FILE = 'jobs.json';
const FILE_VERSION = 1;
/**
 * Completed and failed jobs beyond this count are dropped oldest first. Queued, running and
 * interrupted jobs are always kept, because an interrupted job's scope and progress are what resumes it.
 */
const FINISHED_JOB_LIMIT = 1000;

interface JobsFile {
  version: typeof FILE_VERSION;
  jobs: CollectionJob[];
}

export type NewJobEvent = Omit<JobEvent, 'eventId' | 'timestamp'>;

/** Activity log settings a job store passes on; the store supplies the clock, job lookup and drop handling. */
export type JobActivityOptions = Pick<ActivityLogOptions, 'setTimer' | 'append'>;

/**
 * Device-side record of collection jobs and their timeline. Jobs live in one JSON snapshot that is
 * replaced atomically; events go to the activity log. Both stay outside every Vault, and the
 * activity log's retention never removes a job record.
 */
export class JobStore {
  private readonly jobs = new Map<string, CollectionJob>();
  private flushing: Promise<void> | null = null;
  private dirty = false;
  private activityLog!: ActivityLog;

  private constructor(
    private readonly directory: string | null,
    private readonly now: () => Date,
  ) {}

  /** Keeps everything in memory; for tests and runtimes without a device profile. */
  static memory(now: () => Date = () => new Date()): JobStore {
    const store = new JobStore(null, now);
    store.activityLog = ActivityLog.memory(store.activityOptions({}));
    return store;
  }

  /** The device activity log the store's events go to. */
  get activity(): ActivityLog { return this.activityLog; }

  /**
   * Loads the previous snapshot. Jobs still queued or running belong to a process that stopped
   * without closing, so they become interrupted with their scope and progress kept; a job caught in
   * the middle of a step counts an unclean stop.
   */
  static async open(directory: string, now: () => Date = () => new Date(), activity: JobActivityOptions = {}): Promise<JobStore> {
    const store = new JobStore(directory, now);
    store.activityLog = await ActivityLog.open(directory, store.activityOptions(activity));
    let contents: string | null = null;
    try {
      contents = await readFile(path.join(directory, JOBS_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (contents !== null) {
      const jobs = parseJobs(contents);
      if (jobs) {
        for (const job of jobs) store.jobs.set(job.id, job);
      } else {
        // An unreadable record must not keep the service from starting; it is set aside for diagnosis.
        const target = path.join(directory, JOBS_FILE);
        const corrupt = `${target}.corrupt-${now().toISOString().replace(/[:.]/gu, '-')}`;
        await rename(target, corrupt);
        console.error(`Collection jobs file is unreadable; moved it to ${corrupt} and started with no job history`);
      }
    }
    const stopped = [...store.jobs.values()].filter((job) => job.state === 'queued' || job.state === 'running');
    for (const job of stopped) {
      store.interrupt(job, '服務在工作完成前停止；已保存的內容保留。', { stop: 'crash', unclean: inStep(job) });
    }
    if (stopped.length > 0) await store.flush();
    return store;
  }

  get(id: string): CollectionJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  /** Jobs of one Vault, newest first; jobs created in the same millisecond keep their submission order. */
  list(vaultPath: string): CollectionJob[] {
    // The map keeps insertion order, and the sort is stable, so reversing first puts later submissions first.
    return [...this.jobs.values()]
      .filter((job) => job.vaultPath === vaultPath)
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => structuredClone(job));
  }

  put(job: CollectionJob): void {
    this.jobs.set(job.id, structuredClone(job));
    this.prune();
    this.scheduleFlush();
  }

  /** Marks an unfinished job interrupted, as a stopped service leaves it; the job resumes when its Vault opens. */
  interrupt(job: CollectionJob, message: string, options: { stop: JobStopKind; unclean?: boolean }): void {
    const timestamp = this.now().toISOString();
    const interrupted: CollectionJob = {
      ...job,
      state: 'interrupted',
      recovery: {
        resumedCount: job.recovery?.resumedCount ?? 0,
        uncleanStops: (job.recovery?.uncleanStops ?? 0) + (options.unclean ? 1 : 0),
        lastInterruptedAt: timestamp,
        lastResumedAt: job.recovery?.lastResumedAt ?? null,
        lastStop: options.stop,
      },
      finishedAt: timestamp,
      updatedAt: timestamp,
      error: { code: 'interrupted', message },
      items: job.items?.map((item) => item.state === 'queued' || item.state === 'running'
        ? { ...item, state: 'interrupted' } : item) ?? null,
    };
    this.jobs.set(job.id, interrupted);
    this.event({
      severity: 'warning', eventType: 'job.interrupted', message,
      vaultPath: job.vaultPath, jobId: job.id, ...(job.phase ? { phase: job.phase } : {}),
      ...(job.source.id ? { sourceId: job.source.id } : {}),
    });
    this.scheduleFlush();
  }

  event(entry: NewJobEvent): void {
    this.activityLog.record({ eventId: randomUUID(), timestamp: this.now().toISOString(), ...entry });
  }

  /** Resolves once every change so far is on disk, or the activity log reported why it is not. */
  async flush(): Promise<void> {
    await this.activityLog.flush();
    while (this.dirty || this.flushing) {
      if (this.flushing) await this.flushing;
      else this.scheduleFlush();
    }
  }

  /** Writes what is left and stops the activity log's timers. */
  async close(): Promise<void> {
    await this.activityLog.close();
    await this.flush();
  }

  private activityOptions(activity: JobActivityOptions): ActivityLogOptions {
    return {
      ...activity,
      now: this.now,
      lookupJob: (id) => this.jobs.get(id),
      // A job whose events were lost says so, so its record is not mistaken for complete.
      onDropped: (event: JobEvent) => {
        const job = event.jobId ? this.jobs.get(event.jobId) : undefined;
        if (!job || job.activityIncomplete) return;
        job.activityIncomplete = true;
        this.scheduleFlush();
      },
    };
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushing || !this.directory) {
      if (!this.directory) this.dirty = false;
      return;
    }
    this.flushing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await this.write();
        } catch (error) {
          console.error('Collection jobs write failed', error);
        }
      }
    })().finally(() => { this.flushing = null; });
  }

  private async write(): Promise<void> {
    const directory = this.directory!;
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, JOBS_FILE);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const file: JobsFile = { version: FILE_VERSION, jobs: [...this.jobs.values()] };
    try {
      await writeFile(temporary, `${JSON.stringify(file)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.state === 'completed' || job.state === 'failed')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const job of finished.slice(0, Math.max(0, finished.length - FINISHED_JOB_LIMIT))) this.jobs.delete(job.id);
  }
}

/**
 * True for a job that was doing its own work: capturing, saving or indexing a video, discovering a
 * channel's videos or resolving a channel. A channel job past discovery only waits for its videos.
 */
function inStep(job: CollectionJob): boolean {
  if (job.state !== 'running') return false;
  if (job.kind === 'youtube.video') return job.phase === 'capture' || job.phase === 'save' || job.phase === 'index';
  if (job.kind === 'youtube.channel') return job.phase === 'discover';
  return job.phase === 'resolve';
}

function parseJobs(contents: string): CollectionJob[] | null {
  let parsed: Partial<JobsFile>;
  try {
    parsed = JSON.parse(contents) as Partial<JobsFile>;
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== FILE_VERSION || !Array.isArray(parsed.jobs)) return null;
  const valid = parsed.jobs.every((job) => job && typeof job === 'object' && typeof job.id === 'string'
    && typeof job.vaultPath === 'string' && typeof job.state === 'string');
  return valid ? parsed.jobs : null;
}

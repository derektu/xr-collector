import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile } from '../core/json-file.js';
import { inOwnStep, jobEventSubject } from '../core/job-role.js';
import type { SourceDeclarations } from '../core/source-registry.js';
import type { NoteChange } from '../core/change-feed.js';
import type { CollectionJob, EventRecorder, JobStopKind, NewJobEvent } from '../core/types.js';

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

/**
 * Device-side record of collection jobs. Jobs live in one JSON snapshot that is replaced atomically,
 * outside every Vault. The store does not keep the jobs' timeline: `event()` hands each event to the
 * recorder it was given, the device activity log, whose retention never removes a job record.
 */
export class JobStore {
  private readonly jobs = new Map<string, CollectionJob>();
  private flushing: Promise<void> | null = null;
  private dirty = false;

  private constructor(
    private readonly directory: string | null,
    private readonly sources: SourceDeclarations,
    private readonly events: EventRecorder,
    private readonly now: () => Date,
    private readonly noteChange: NoteChange = () => undefined,
  ) {}

  /**
   * Keeps every job in memory; for tests and runtimes without a device profile. `sources` gives
   * the roles of the stored jobs' kinds; `noteChange` hears every job change.
   */
  static memory(sources: SourceDeclarations, events: EventRecorder, now: () => Date = () => new Date(), noteChange?: NoteChange): JobStore {
    return new JobStore(null, sources, events, now, noteChange);
  }

  /**
   * Loads the previous snapshot. Jobs still queued or running belong to a process that stopped
   * without closing, so they become interrupted with their scope and progress kept; a job caught in
   * the middle of a step counts an unclean stop. `sources` gives the roles of the stored jobs' kinds.
   */
  static async open(
    directory: string, sources: SourceDeclarations, events: EventRecorder, now: () => Date = () => new Date(), noteChange?: NoteChange,
  ): Promise<JobStore> {
    const store = new JobStore(directory, sources, events, now, noteChange);
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
      store.interrupt(job, '服務在工作完成前停止；已保存的內容保留。', { stop: 'crash', unclean: inOwnStep(sources, job) });
    }
    if (stopped.length > 0) await store.flush();
    return store;
  }

  get(id: string): CollectionJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  /**
   * Jobs of one Vault, newest first; jobs created in the same millisecond keep their submission order.
   * A job belongs to the Vault when both its path and its Vault ID match; `vaultId` null selects the
   * jobs at the path that carry no ID.
   */
  list(vaultPath: string, vaultId: string | null = null): CollectionJob[] {
    // The map keeps insertion order, and the sort is stable, so reversing first puts later submissions first.
    return [...this.jobs.values()]
      .filter((job) => belongsTo(job, vaultPath, vaultId))
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => structuredClone(job));
  }

  put(job: CollectionJob): void {
    this.jobs.set(job.id, structuredClone(job));
    this.prune();
    this.scheduleFlush();
    this.noteChange({ kind: 'job', id: job.id, parentId: job.parentId, state: job.state });
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
    this.noteChange({ kind: 'job', id: job.id, parentId: job.parentId, state: 'interrupted' });
    // A crash is the only unexpected interruption. Shutdowns and Vault operations resume normally.
    const planned = options.stop !== 'crash';
    this.event({
      severity: planned ? 'debug' : 'warning', eventType: 'job.interrupted', message, ...(job.phase ? { phase: job.phase } : {}),
      ...jobEventSubject(this.sources, job, (id) => this.jobs.get(id)),
    });
    this.scheduleFlush();
  }

  event(entry: NewJobEvent): void {
    this.events.event(entry);
  }

  /** The title of a job's item or target, once the job knows it. */
  sourceTitle(id: string): string | undefined {
    return this.jobs.get(id)?.source.title || undefined;
  }

  /** Marks a job whose events were lost, so its record is not mistaken for complete. */
  noteActivityLost(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.activityIncomplete) return;
    job.activityIncomplete = true;
    this.scheduleFlush();
  }

  /** Resolves once every job change so far is on disk. */
  async flush(): Promise<void> {
    while (this.dirty || this.flushing) {
      if (this.flushing) await this.flushing;
      else this.scheduleFlush();
    }
  }

  /** Writes what is left. */
  async close(): Promise<void> {
    await this.flush();
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
      await replaceFile(temporary, target);
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

function belongsTo(job: CollectionJob, vaultPath: string, vaultId: string | null): boolean {
  return job.vaultPath === vaultPath && (job.vaultId ?? null) === vaultId;
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

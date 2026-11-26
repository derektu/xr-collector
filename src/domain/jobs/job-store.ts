import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import { replaceFile } from '../../shared/lib/json-file.js';
import { inOwnStep, jobEventSubject } from '../../shared/jobs/job-role.js';
import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { NoteChange } from '../../shared/api/changes.js';
import type { CollectionJob, JobStopKind } from '../../shared/jobs/job-types.js';
import type { EventRecorder, NewJobEvent } from '../../shared/activity/activity-types.js';
import type { LogWriter } from '../../shared/log/log-types.js';

const JOBS_FILE = 'jobs.json';
const FILE_VERSION = 1;
const FINISHED_JOB_LIMIT = 1000;

interface JobsFile {
  version: typeof FILE_VERSION;
  jobs: CollectionJob[];
}

export class JobStore {
  private readonly jobs = new Map<string, CollectionJob>();
  private flushing: Promise<void> | null = null;
  private dirty = false;
  private writeFailure: CollectorError | null = null;

  private constructor(
    private readonly directory: string | null,
    private readonly sources: SourceDeclarations,
    private readonly events: EventRecorder,
    private readonly log: LogWriter,
    private readonly now: () => Date,
    private readonly noteChange: NoteChange = () => undefined,
  ) {}

  static memory(sources: SourceDeclarations, events: EventRecorder, log: LogWriter, now: () => Date = () => new Date(), noteChange?: NoteChange): JobStore {
    return new JobStore(null, sources, events, log, now, noteChange);
  }

  static async open(
    directory: string, sources: SourceDeclarations, events: EventRecorder, log: LogWriter, now: () => Date = () => new Date(), noteChange?: NoteChange,
  ): Promise<JobStore> {
    const store = new JobStore(directory, sources, events, log, now, noteChange);
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
        const target = path.join(directory, JOBS_FILE);
        const corrupt = `${target}.corrupt-${now().toISOString().replace(/[:.]/gu, '-')}`;
        await rename(target, corrupt);
        log.write({ level: 'error', source: 'jobs', message: `Collection jobs file is unreadable; moved it to ${corrupt} and started with no job history` });
      }
    }
    const stopped = [...store.jobs.values()].filter((job) => job.state === 'queued' || job.state === 'running');
    for (const job of stopped) {
      store.interrupt(job, '服務在工作完成前停止；已保存的內容保留。', { stop: 'crash', unclean: inOwnStep(sources, job) });
    }
    if (stopped.length > 0) await store.flushOrLog();
    return store;
  }

  get(id: string): CollectionJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  /** Newest first; jobs created in the same millisecond keep their submission order. */
  list(vaultPath: string, vaultId: string): CollectionJob[] {
    return [...this.jobs.values()]
      .filter((job) => belongsTo(job, vaultPath, vaultId))
      .reverse()
      .sort(byCreatedAtDescending)
      .map((job) => structuredClone(job));
  }

  put(job: CollectionJob): void {
    this.jobs.set(job.id, structuredClone(job));
    this.prune();
    this.scheduleFlush();
    this.noteChange({ kind: 'job', id: job.id, parentId: job.parentId, state: job.state });
  }

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

  /**
   * Resolves once every job change so far is written to disk, writing again when the last write
   * failed; rejects with `jobs_write_failed` when the latest write fails. A memory store resolves at
   * once.
   */
  async flush(): Promise<void> {
    if (this.writeFailure) this.scheduleFlush();
    while (this.dirty || this.flushing) {
      if (this.flushing) await this.flushing;
      else this.scheduleFlush();
    }
    if (this.writeFailure) throw this.writeFailure;
  }

  async close(): Promise<void> {
    await this.flushOrLog();
  }

  private async flushOrLog(): Promise<void> {
    await this.flush().catch((error: unknown) => this.log.write({ level: 'error', source: 'jobs', message: 'Collection jobs are not written', error }));
  }

  private scheduleFlush(): void {
    const { directory } = this;
    if (!directory) return;
    this.dirty = true;
    if (this.flushing) return;
    this.flushing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await this.write(directory);
          this.writeFailure = null;
        } catch (error) {
          this.log.write({ level: 'error', source: 'jobs', message: 'Collection jobs write failed', error });
          this.writeFailure = new CollectorError('jobs_write_failed', '無法寫入工作紀錄，請確認磁碟空間後再試。', { cause: error });
        }
      }
    })().finally(() => { this.flushing = null; });
  }

  private async write(directory: string): Promise<void> {
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

function belongsTo(job: CollectionJob, vaultPath: string, vaultId: string): boolean {
  return job.vaultPath === vaultPath && job.vaultId === vaultId;
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

function byCreatedAtDescending(a: CollectionJob, b: CollectionJob): number {
  return b.createdAt.localeCompare(a.createdAt);
}

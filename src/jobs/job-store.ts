import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CollectionJob, JobEvent } from '../core/types.js';

const JOBS_FILE = 'jobs.json';
const EVENTS_FILE = 'events.jsonl';
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

/**
 * Device-side record of collection jobs and their timeline. Jobs live in one JSON snapshot that is
 * replaced atomically; events append to a JSONL file. Both stay outside every Vault.
 */
export class JobStore {
  private readonly jobs = new Map<string, CollectionJob>();
  private flushing: Promise<void> | null = null;
  private dirty = false;
  private eventTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly directory: string | null,
    private readonly now: () => Date,
  ) {}

  /** Keeps everything in memory; for tests and runtimes without a device profile. */
  static memory(now: () => Date = () => new Date()): JobStore {
    return new JobStore(null, now);
  }

  /**
   * Loads the previous snapshot. Jobs still queued or running belong to a process that stopped,
   * so they become interrupted with their scope and progress kept.
   */
  static async open(directory: string, now: () => Date = () => new Date()): Promise<JobStore> {
    const store = new JobStore(directory, now);
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
      store.interrupt(job, '服務在工作完成前停止；已保存的內容保留。');
    }
    if (stopped.length > 0) await store.flush();
    return store;
  }

  get(id: string): CollectionJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  /** Jobs of one Vault, newest first. */
  list(vaultPath: string): CollectionJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.vaultPath === vaultPath)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((job) => structuredClone(job));
  }

  put(job: CollectionJob): void {
    this.jobs.set(job.id, structuredClone(job));
    this.prune();
    this.scheduleFlush();
  }

  /** Marks an unfinished job interrupted, as a stopped service leaves it. */
  interrupt(job: CollectionJob, message: string): void {
    const timestamp = this.now().toISOString();
    const interrupted: CollectionJob = {
      ...job,
      state: 'interrupted',
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
    const event: JobEvent = { eventId: randomUUID(), timestamp: this.now().toISOString(), ...entry };
    if (!this.directory) return;
    const file = path.join(this.directory, EVENTS_FILE);
    this.eventTail = this.eventTail
      .then(async () => {
        await mkdir(this.directory!, { recursive: true });
        await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
      })
      .catch((error: unknown) => console.error('Collection event write failed', error));
  }

  /** Resolves once every change so far is on disk. */
  async flush(): Promise<void> {
    while (this.dirty || this.flushing) {
      if (this.flushing) await this.flushing;
      else this.scheduleFlush();
    }
    await this.eventTail;
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

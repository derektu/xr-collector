import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChannelScheduleStore,
  StoredChannelSchedule,
} from './channel-scheduler.js';

const DEFAULT_SCHEDULE: StoredChannelSchedule = {
  enabled: false,
  intervalMinutes: 60,
  lastAttemptAt: null,
  lastCompletedAt: null,
  nextRunAt: null,
  lastResult: null,
};

interface ScheduleFile extends StoredChannelSchedule {
  version: 1;
}

export class JsonChannelScheduleStore implements ChannelScheduleStore {
  private readonly filePath: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(vaultRoot: string) {
    this.filePath = path.join(vaultRoot, 'settings', 'youtube-schedule.json');
  }

  async load(): Promise<StoredChannelSchedule> {
    await this.mutation;
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_SCHEDULE);
      throw error;
    }
    const parsed: unknown = JSON.parse(contents);
    if (!isScheduleFile(parsed)) throw new Error('Invalid YouTube channel schedule settings');
    const { version: _version, ...schedule } = parsed;
    return schedule;
  }

  save(schedule: StoredChannelSchedule): Promise<void> {
    const value = structuredClone(schedule);
    const operation = this.mutation.then(
      () => this.writeSchedule(value),
      () => this.writeSchedule(value),
    );
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeSchedule(schedule: StoredChannelSchedule): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const contents = `${JSON.stringify({ version: 1, ...schedule }, null, 2)}\n`;
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function isScheduleFile(value: unknown): value is ScheduleFile {
  if (!value || typeof value !== 'object') return false;
  const schedule = value as Partial<ScheduleFile>;
  return schedule.version === 1
    && typeof schedule.enabled === 'boolean'
    && Number.isInteger(schedule.intervalMinutes)
    && (schedule.intervalMinutes ?? 0) >= 1
    && (schedule.intervalMinutes ?? 0) <= 10_080
    && isNullableString(schedule.lastAttemptAt)
    && isNullableString(schedule.lastCompletedAt)
    && isNullableString(schedule.nextRunAt)
    && (schedule.lastResult === null || isLastResult(schedule.lastResult));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isLastResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return (result.runId === null || typeof result.runId === 'string')
    && isNonNegativeInteger(result.created)
    && isNonNegativeInteger(result.existing)
    && isNonNegativeInteger(result.failed)
    && (result.error === undefined || typeof result.error === 'string');
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

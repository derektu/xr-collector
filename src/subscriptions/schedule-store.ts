import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/json-file.js';
import { scheduleFile } from '../core/source-registry.js';
import type { ScheduleStore, StoredSchedule } from './scheduler.js';
import { scheduleEnabledFromJson, type ScheduleFile } from './subscription-files.js';

/**
 * The automatic collection switch in the Vault file the assembly names. A Vault without the file
 * collects automatically. Saving keeps the other fields of the file.
 */
export class JsonScheduleStore implements ScheduleStore {
  private readonly filePath: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(vaultRoot: string) {
    this.filePath = path.join(vaultRoot, scheduleFile());
  }

  async load(): Promise<StoredSchedule> {
    await this.mutation;
    return { enabled: scheduleEnabledFromJson(await readJsonFile(this.filePath)) };
  }

  save(schedule: StoredSchedule): Promise<void> {
    const write = async () => {
      const stored = await readJsonFile(this.filePath).catch(() => undefined);
      const kept = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as object : {};
      const file: ScheduleFile = { ...kept, version: 2, enabled: schedule.enabled };
      await writeJsonFile(this.filePath, file);
    };
    const operation = this.mutation.then(write, write);
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

import path from 'node:path';
import type { ChannelScheduleStore, StoredChannelSchedule } from './channel-scheduler.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { SCHEDULE_FILE, scheduleEnabledFromJson, type ScheduleFile } from './subscription-files.js';

/** The automatic collection switch in the Vault. A Vault without the file collects automatically. */
export class JsonChannelScheduleStore implements ChannelScheduleStore {
  private readonly filePath: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(vaultRoot: string) {
    this.filePath = path.join(vaultRoot, SCHEDULE_FILE);
  }

  async load(): Promise<StoredChannelSchedule> {
    await this.mutation;
    return { enabled: scheduleEnabledFromJson(await readJsonFile(this.filePath)) };
  }

  save(schedule: StoredChannelSchedule): Promise<void> {
    const file: ScheduleFile = { version: 2, enabled: schedule.enabled };
    const write = () => writeJsonFile(this.filePath, file);
    const operation = this.mutation.then(write, write);
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

import path from 'node:path';
import type { ChannelScheduleStore, StoredChannelSchedule } from './channel-scheduler.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { legacySettingsFromJson, SCHEDULE_FILE, scheduleEnabledFromJson, type ScheduleFile } from './subscription-files.js';

/**
 * The automatic collection switch in the Vault. A Vault without the file collects automatically.
 * Saving keeps the `legacySettings` of a converted Vault and any other field of a version 2 file.
 */
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
    const write = async () => {
      const stored = await readJsonFile(this.filePath).catch(() => undefined);
      const legacySettings = legacySettingsFromJson(stored);
      // A version 2 file keeps its other fields; a version 1 file contributes only its shared settings.
      const kept = stored && typeof stored === 'object' && (stored as { version?: unknown }).version === 2 ? stored as object : {};
      const file: ScheduleFile = { ...kept, version: 2, enabled: schedule.enabled, ...(legacySettings ? { legacySettings } : {}) };
      await writeJsonFile(this.filePath, file);
    };
    const operation = this.mutation.then(write, write);
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

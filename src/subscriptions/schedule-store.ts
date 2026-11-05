import path from 'node:path';
import type { NoteChange } from '../core/change-feed.js';
import { readJsonFile } from '../core/json-file.js';
import { scheduleFile } from '../core/source-registry.js';
import type { VaultFiles } from '../core/vault-files.js';
import type { ScheduleStore, StoredSchedule } from './scheduler.js';
import { scheduleEnabledFromJson, type ScheduleFile } from './subscription-files.js';

/**
 * The automatic collection switch in the Vault file the assembly names. A Vault without the file
 * collects automatically. Saving keeps the other fields of the file and goes through the Vault's
 * `VaultFiles`.
 */
export class JsonScheduleStore implements ScheduleStore {
  private readonly file = scheduleFile();
  private readonly filePath: string;
  private mutation: Promise<void> = Promise.resolve();

  /** `noteChange` hears each saved switch once the file holds it. */
  constructor(private readonly files: VaultFiles, private readonly noteChange: NoteChange = () => undefined) {
    this.filePath = path.join(files.root, ...this.file.split('/'));
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
      await this.files.writeJson(this.file, file);
      this.noteChange({ kind: 'schedule' });
    };
    const operation = this.mutation.then(write, write);
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

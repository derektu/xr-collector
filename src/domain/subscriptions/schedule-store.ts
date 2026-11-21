import path from 'node:path';
import type { NoteChange } from '../../shared/api/changes.js';
import { readJsonFile } from '../../shared/lib/json-file.js';
import type { VaultFiles } from '../../shared/vault/vault-files.js';
import type { ScheduleStore, StoredSchedule } from './scheduler.js';
import { scheduleEnabledFromJson, type ScheduleFile } from './subscription-files.js';

export class JsonScheduleStore implements ScheduleStore {
  private readonly filePath: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly files: VaultFiles, private readonly noteChange: NoteChange = () => undefined) {
    this.filePath = path.join(files.root, ...files.sources.schedule.file.split('/'));
  }

  async load(): Promise<StoredSchedule> {
    await this.mutation;
    return { enabled: scheduleEnabledFromJson(await readJsonFile(this.filePath), this.files.sources.schedule.description) };
  }

  save(schedule: StoredSchedule): Promise<void> {
    const write = async () => {
      const stored = await readJsonFile(this.filePath).catch(() => undefined);
      const kept = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as object : {};
      const file: ScheduleFile = { ...kept, version: 2, enabled: schedule.enabled };
      await this.files.writeJson(this.files.sources.schedule.file, file);
      this.noteChange({ kind: 'schedule' });
    };
    const operation = this.mutation.then(write, write);
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

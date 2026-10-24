import { readJsonFile, writeJsonFile } from '../core/json-file.js';

/**
 * Whether the device has already been told, the first time its window closed, that the app keeps
 * running in the tray. The record lives in the Electron device profile; a missing or unreadable
 * file counts as not told, so at worst the hint shows once more.
 */
export class CloseHintRecord {
  constructor(private readonly file: string) {}

  async shown(): Promise<boolean> {
    try {
      const parsed = await readJsonFile(this.file);
      return typeof parsed === 'object' && parsed !== null && (parsed as { closeHintShown?: unknown }).closeHintShown === true;
    } catch (error: unknown) {
      console.warn('Unable to read the close hint record', error);
      return false;
    }
  }

  async markShown(): Promise<void> {
    await writeJsonFile(this.file, { closeHintShown: true });
  }
}

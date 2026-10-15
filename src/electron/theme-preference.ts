import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** `system` follows the operating system's light or dark appearance; it is also the value for a missing or invalid file. */
export type StoredTheme = 'system' | 'dark' | 'light';
export function isStoredTheme(value: unknown): value is StoredTheme { return value === 'system' || value === 'dark' || value === 'light'; }

/** Stores only a presentation preference in the Electron device profile. */
export class FileThemePreference {
  // Writes share one temporary file name, so each write waits for the previous one to finish.
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<StoredTheme> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && isStoredTheme((parsed as { theme?: unknown }).theme)) return (parsed as { theme: StoredTheme }).theme;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') console.warn('Unable to read theme preference', error);
    }
    return 'system';
  }
  write(theme: StoredTheme): Promise<void> {
    const next = this.pending.catch(() => undefined).then(() => this.writeNow(theme));
    this.pending = next;
    return next;
  }
  private async writeNow(theme: StoredTheme): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ theme }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
  }
}

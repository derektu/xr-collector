import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StoredTheme = 'dark' | 'light';
function validTheme(value: unknown): value is StoredTheme { return value === 'dark' || value === 'light'; }

/** Stores only a presentation preference in the Electron device profile. */
export class FileThemePreference {
  constructor(private readonly file: string) {}
  async read(): Promise<StoredTheme> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && validTheme((parsed as { theme?: unknown }).theme)) return (parsed as { theme: StoredTheme }).theme;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return 'dark';
    }
    return 'dark';
  }
  async write(theme: StoredTheme): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ theme }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
  }
}

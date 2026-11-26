import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile } from '../../shared/lib/json-file.js';
import type { LogWriter } from '../../shared/log/log-types.js';

export type StoredTheme = 'system' | 'dark' | 'light';
export function isStoredTheme(value: unknown): value is StoredTheme { return value === 'system' || value === 'dark' || value === 'light'; }

function hasStoredTheme(value: unknown): value is { theme: StoredTheme } {
  return typeof value === 'object' && value !== null && 'theme' in value && isStoredTheme(value.theme);
}

export class FileThemePreference {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly log: LogWriter) {}
  async read(): Promise<StoredTheme> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (hasStoredTheme(parsed)) return parsed.theme;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        this.log.write({ level: 'warn', source: 'desktop', message: 'Unable to read theme preference', error });
      }
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
    await replaceFile(temporary, this.file);
  }
}

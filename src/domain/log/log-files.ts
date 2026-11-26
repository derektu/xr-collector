import { appendFile, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';

export const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
export const CURRENT_FILE = 'collector.jsonl';
export const PREVIOUS_FILE = 'collector.1.jsonl';

export class LogFiles {
  private pending: string[] = [];
  private draining: Promise<void> | null = null;
  private size: number | null = null;
  private failureReported = false;
  private readonly current: string;
  private readonly previous: string;

  constructor(
    private readonly folder: string,
    private readonly maxFileBytes: number,
    private readonly reportFailure: (error: unknown) => void,
  ) {
    this.current = path.join(folder, CURRENT_FILE);
    this.previous = path.join(folder, PREVIOUS_FILE);
  }

  append(line: string): void {
    this.pending.push(`${line}\n`);
    this.draining ??= this.drain();
  }

  async flushed(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const lines = this.pending;
      this.pending = [];
      await this.write(lines);
    }
    this.draining = null;
  }

  private async write(lines: readonly string[]): Promise<void> {
    try {
      let size = this.size ?? await this.openedSize();
      let chunk = '';
      for (const line of lines) {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > this.maxFileBytes) {
          if (chunk !== '') await appendFile(this.current, chunk, 'utf8');
          chunk = '';
          if (await this.rotate()) size = 0;
        }
        chunk += line;
        size += bytes;
      }
      await appendFile(this.current, chunk, 'utf8');
      this.size = size;
    } catch (error) {
      this.size = null;
      this.report(error);
    }
  }

  private async rotate(): Promise<boolean> {
    try {
      await rename(this.current, this.previous);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private report(error: unknown): void {
    if (!this.failureReported) this.reportFailure(error);
    this.failureReported = true;
  }

  private async openedSize(): Promise<number> {
    await mkdir(this.folder, { recursive: true });
    const handle = await open(this.current, 'a+');
    try {
      const { size } = await handle.stat();
      if (size === 0) return 0;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last.toString('utf8') === '\n') return size;
      await handle.appendFile('\n', 'utf8');
      return size + 1;
    } finally {
      await handle.close();
    }
  }
}

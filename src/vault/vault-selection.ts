import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Device-local record of which Vault this profile uses; never stored inside a Vault. */
export class VaultSelection {
  constructor(readonly file: string) {}

  /** Returns the saved absolute Vault path, or null when this device has not chosen one. */
  async read(): Promise<string | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Invalid Vault selection file', { cause: error });
    }
    if (!value || typeof value !== 'object' || !('path' in value)
      || typeof value.path !== 'string' || !path.isAbsolute(value.path)) {
      throw new Error('Invalid Vault selection file');
    }
    return value.path;
  }

  async write(vaultPath: string): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ path: vaultPath }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

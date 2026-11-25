import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile } from '../../shared/lib/json-file.js';
import { errorCode } from './errno.js';

export class VaultSelection {
  readonly file: string;

  constructor(readonly profilePath: string) {
    this.file = path.join(profilePath, 'vault-selection.json');
  }

  /** Null when this device has not chosen a Vault; throws when the file is damaged. */
  async read(): Promise<string | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
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
      await replaceFile(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

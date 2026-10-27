import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { expect, it } from 'vitest';
import yazl from 'yazl';
import { validateMacUpdateArchive } from '../../src/updates/mac-installer.js';

async function archive(entries: Array<{ name: string; body?: string; mode?: number }>): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'xr-mac-update-archive-')); const file = path.join(folder, 'app.zip');
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.body ?? 'x'), entry.name, entry.mode ? { mode: entry.mode } : undefined);
  zip.end(); await pipeline(zip.outputStream, createWriteStream(file)); return file;
}

it('accepts one app root but rejects escaping symlinks and traversal before ditto extraction', async () => {
  await expect(validateMacUpdateArchive(await archive([{ name: 'Probe.app/Contents/Info.plist' }]))).resolves.toBeUndefined();
  await expect(validateMacUpdateArchive(await archive([
    { name: 'Probe.app/Contents/Info.plist' },
    { name: 'Probe.app/Contents/escape', body: '../../../../outside', mode: 0o120777 },
  ]))).rejects.toMatchObject({ code: 'update_integrity_failed' });
  await expect(validateMacUpdateArchive(await archive([
    { name: 'Probe.app/alias', body: '.', mode: 0o120777 },
    { name: 'Probe.app/link', body: 'alias/../outside', mode: 0o120777 },
  ]))).rejects.toMatchObject({ code: 'update_integrity_failed' });
  await expect(validateMacUpdateArchive(await archive([
    { name: 'Probe.app/alias', body: 'Contents', mode: 0o120777 },
    { name: 'Probe.app/alias/file' },
  ]))).rejects.toMatchObject({ code: 'update_integrity_failed' });

  const original = await archive([{ name: 'Probe.app/good' }]); const bytes = await readFile(original);
  const from = Buffer.from('Probe.app/good'); const to = Buffer.from('../escape.txt');
  for (let offset = bytes.indexOf(from); offset >= 0; offset = bytes.indexOf(from, offset + to.length)) to.copy(bytes, offset);
  const traversal = `${original}.traversal.zip`; await writeFile(traversal, bytes);
  await expect(validateMacUpdateArchive(traversal)).rejects.toMatchObject({ code: 'update_integrity_failed' });
});


// On Windows a scan that holds a just-written state file open without delete sharing makes the
// replacing rename fail with EPERM. Without a retry, jobs, cooldowns and subscription changes are not
// saved and come back in their old state after a restart; a target that stays locked must still end
// the write with an error instead of blocking it.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonFile, writeJsonFile } from '../../src/core/json-file.js';

const holders: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    if (holder.exitCode !== null || holder.signalCode !== null) continue;
    const exited = once(holder, 'exit');
    holder.kill();
    await exited;
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/**
 * A PowerShell process that opens `file` sharing read and write but not delete, then closes it after
 * `holdMs`, standing in for a scan of a file just written.
 */
async function holdWithoutDeleteSharing(file: string, holdMs: number): Promise<ChildProcess> {
  const script = `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'ReadWrite'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${holdMs}; $f.Close()`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  holders.push(holder);
  const [chunk] = (await once(holder.stdout!, 'data')) as [Buffer];
  expect(chunk.toString()).toContain('held');
  return holder;
}

async function stateFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xr-json-file-'));
  directories.push(directory);
  const file = path.join(directory, 'state.json');
  await writeFile(file, '{"value":"old"}\n');
  return file;
}

describe.skipIf(process.platform !== 'win32')('writeJsonFile while another process holds the target', () => {
  it('replaces the target once the other process closes it', async () => {
    const file = await stateFile();
    await holdWithoutDeleteSharing(file, 300);

    await writeJsonFile(file, { value: 'new' });

    expect(await readJsonFile(file)).toEqual({ value: 'new' });
  });

  it('fails instead of waiting while the target stays held', async () => {
    const file = await stateFile();
    await holdWithoutDeleteSharing(file, 60_000);

    await expect(writeJsonFile(file, { value: 'new' })).rejects.toMatchObject({ code: 'EPERM' });

    expect(await readFile(file, 'utf8')).toBe('{"value":"old"}\n');
  });
});

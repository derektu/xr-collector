// The Windows process start watcher of the desktop smoke. Its PowerShell process is ended once, and
// only while it still runs: after it exits its PID may belong to another program, whose whole tree
// taskkill would end. A fake watcher process stands in for PowerShell, so this runs on every platform.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { watchWindowsStarts } from '../../../.claude/skills/verify/scripts/lib/platform.mjs';

/** A stand-in for the spawned PowerShell: a PID, piped standard output and the exit state. */
function fakeWatcher() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, stdout: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
  });
  return child;
}

function watch() {
  const child = fakeWatcher();
  const ended: number[] = [];
  const started: object[] = [];
  const watcher = watchWindowsStarts((row: object) => started.push(row), { start: () => child, endTree: (pid: number) => ended.push(pid) });
  return { child, ended, started, watcher };
}

describe('watchWindowsStarts', () => {
  it('reports each started process after the watcher is ready', async () => {
    const { child, started, watcher } = watch();
    child.stdout.write('ready\r\n7|4|C:\\bin\\yt-dlp.exe\r\n8|7|\r\n');
    await watcher.ready;
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([{ pid: 7, ppid: 4, executable: 'C:\\bin\\yt-dlp.exe' }, { pid: 8, ppid: 7, executable: null }]);
  });

  it('ends the running watcher once, however often stop is called', () => {
    const { ended, watcher } = watch();
    watcher.stop();
    watcher.stop();
    expect(ended).toEqual([4242]);
  });

  it('leaves the PID alone once the watcher has exited', () => {
    const { child, ended, watcher } = watch();
    child.exitCode = 1;
    child.emit('exit', 1, null);
    watcher.stop();
    expect(ended).toEqual([]);
  });
});

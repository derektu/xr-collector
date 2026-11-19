// Installing a Mac update: the downloaded ZIP must hold one App with no escaping link or path, the
// handoff completes only once a live helper waits for the App to exit, a cancel removes its staging,
// the next start removes a finished journal only after its result is recorded, even one acknowledged
// late, but never one that needs recovery, and a failed launch exits only into a prepared rollback.
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { preparedMacHandoff, recoverMacUpdateResults, rollBackFailedMacLaunch, validateMacUpdateArchive } from '../../../src/domain/updates/mac-installer.js';
import { eventually } from '../../support/wait.js';

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

it('refuses handoff when the prepared helper process has already died', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'xr-mac-handoff-dead-'));
  await writeFile(path.join(workDir, 'result.json'), JSON.stringify({ phase: 'prepared' }));
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.once('exit', resolve));
  const prepared = preparedMacHandoff({ workDir, runId: 'run', nonce: 'n'.repeat(64), parentPid: process.pid,
    expectedVersion: '0.1.2', expectedBuildId: 'build-b', child, signal: new AbortController().signal, abort: vi.fn() });
  await expect(prepared.handoff()).rejects.toThrow('helper 已結束');
  await expect(stat(path.join(workDir, 'handoff.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(workDir, { recursive: true, force: true });
});

it('does not complete handoff until a live helper acknowledges waiting for parent exit', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'xr-mac-handoff-live-'));
  await writeFile(path.join(workDir, 'result.json'), JSON.stringify({ phase: 'prepared' }));
  // The helper acknowledges once it has the handoff and the test lets it.
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs'), path=require('node:path'), root=process.argv[1];
    const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'handoff.json'))&&fs.existsSync(path.join(root,'acknowledge'))){
      fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({phase:'waiting_for_exit'}));setTimeout(()=>process.exit(0),200);
      clearInterval(timer);
    }},5);
  `, workDir]);
  const prepared = preparedMacHandoff({ workDir, runId: 'run', nonce: 'n'.repeat(64), parentPid: process.pid,
    expectedVersion: '0.1.2', expectedBuildId: 'build-b', child, signal: new AbortController().signal, abort: vi.fn() });
  let completed = false; const handingOff = prepared.handoff().then(() => { completed = true; });
  await eventually(() => stat(path.join(workDir, 'handoff.json'))); expect(completed).toBe(false);
  await writeFile(path.join(workDir, 'acknowledge'), '');
  await handingOff; expect(completed).toBe(true);
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(workDir, { recursive: true, force: true });
});

it('removes an uncommitted staging directory after cancellation stops its helper', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'xr-mac-handoff-cancel-'));
  await writeFile(path.join(workDir, 'result.json'), JSON.stringify({ phase: 'prepared' }));
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs'), path=require('node:path'), root=process.argv[1];
    const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'abort.json'))){clearInterval(timer);process.exit(0)}},5);
  `, workDir]);
  const prepared = preparedMacHandoff({ workDir, runId: 'run', nonce: 'n'.repeat(64), parentPid: process.pid,
    expectedVersion: '0.1.2', expectedBuildId: 'build-b', child, signal: new AbortController().signal,
    abort: () => { void writeFile(path.join(workDir, 'abort.json'), '{}'); } });
  await prepared.cancel();
  await expect(stat(workDir)).rejects.toMatchObject({ code: 'ENOENT' });
});

const current = { schemaVersion: 1, kind: 'packaged', version: '0.1.2', buildId: 'build-b', builtAt: new Date().toISOString(),
  commit: 'a'.repeat(40), target: 'darwin-arm64', sourceDirty: false } as const;

async function finishedJournal(phase: string, helperRemovesJournal = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xr-mac-recovery-'));
  const workDir = path.join(root, '.xr-update-run'); await mkdir(workDir);
  const request = { runId: 'run-id', previousVersion: '0.1.1', previousBuildId: 'build-a', expectedVersion: '0.1.2', expectedBuildId: 'build-b' };
  await writeFile(path.join(workDir, 'request.json'), JSON.stringify(request));
  await writeFile(path.join(workDir, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: 'run-id', phase, reason: 'helper reason' }));
  const helper = path.join(root, 'xr-mac-update-helper');
  await writeFile(helper, helperRemovesJournal ? '#!/bin/sh\n[ "$1" = --cleanup ] && rm -rf "$(dirname "$2")"\n' : '#!/bin/sh\nexit 3\n');
  await chmod(helper, 0o755);
  const recover = (record: (result: unknown) => Promise<boolean>, report = vi.fn()) => recoverMacUpdateResults(helper, current,
    { record, report }, { platform: 'darwin', contexts: async () => [{ workDir, request }] });
  return { root, workDir, recover };
}

it.skipIf(process.platform === 'win32')('removes a finished journal only after its result is recorded', async () => {
  const { root, workDir, recover } = await finishedJournal('succeeded');
  const journalAtRecord: boolean[] = [];
  const record = vi.fn(async () => { journalAtRecord.push(await stat(workDir).then(() => true, () => false)); return true; });
  await expect(recover(record)).resolves.toBe(true);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ token: 'run-id', phase: 'succeeded', reason: 'helper reason' }));
  expect(journalAtRecord).toEqual([true]);
  await expect(stat(workDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('keeps the journal when recording fails or declines the result', async () => {
  const { root, workDir, recover } = await finishedJournal('succeeded');
  const report = vi.fn();
  await expect(recover(async () => { throw new Error('disk full'); }, report)).resolves.toBe(false);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
  await expect(recover(async () => false)).resolves.toBe(true);
  await expect(stat(workDir)).resolves.toBeDefined();
  await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('never removes recovery-required evidence and reports the launch not ready', async () => {
  const { root, workDir, recover } = await finishedJournal('recovery_required');
  const record = vi.fn(async () => true);
  await expect(recover(record)).resolves.toBe(false);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'recovery_required' }));
  await expect(stat(workDir)).resolves.toBeDefined();
  await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('reports a cleanup the helper does not finish without throwing into startup', async () => {
  const { root, recover } = await finishedJournal('succeeded', false);
  const report = vi.fn();
  await expect(recover(async () => true, report)).resolves.toBe(false);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('未清除') }));
  await rm(root, { recursive: true, force: true });
});

it('exits into a failed-launch rollback only after the helper has prepared it', async () => {
  const exit = vi.fn();
  const acknowledgeShutdown = vi.fn(async () => true);
  let prepared!: (value: { workDir: string }) => void;
  const prepareRollback = vi.fn(() => new Promise<{ workDir: string } | null>((resolve) => { prepared = resolve; }));
  const rollingBack = rollBackFailedMacLaunch('helper', current, exit, { acknowledgeShutdown, prepareRollback });
  await eventually(() => expect(prepareRollback).toHaveBeenCalled());
  expect(acknowledgeShutdown).toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  prepared({ workDir: 'run' });
  await expect(rollingBack).resolves.toBe(true);
  expect(exit).toHaveBeenCalledTimes(1);

  exit.mockClear();
  await expect(rollBackFailedMacLaunch('helper', current, exit, { acknowledgeShutdown, prepareRollback: async () => null })).resolves.toBe(false);
  await expect(rollBackFailedMacLaunch('helper', current, exit, { acknowledgeShutdown: async () => false, prepareRollback })).resolves.toBe(false);
  expect(exit).not.toHaveBeenCalled();
});

it('lets a valid acknowledgement that arrived after the deadline commit recovery without rolling B back', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'xr-mac-late-ack-')); const nonce = 'a'.repeat(64);
  const request = { runId: 'late-run', nonce, previousVersion: '0.1.1', previousBuildId: 'build-a',
    expectedVersion: '0.1.2', expectedBuildId: 'build-b' };
  await writeFile(path.join(workDir, 'request.json'), JSON.stringify(request));
  await writeFile(path.join(workDir, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: request.runId, phase: 'recovery_required' }));
  await writeFile(path.join(workDir, 'ack.json'), JSON.stringify({ schemaVersion: 1, runId: request.runId, nonce,
    version: request.expectedVersion, buildId: request.expectedBuildId, pid: 123, launchedStartedAt: 'started' }));
  const runHelper = vi.fn(async () => {
    await writeFile(path.join(workDir, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: request.runId, phase: 'succeeded' }));
  });
  const record = vi.fn(async () => false);
  const recovered = await recoverMacUpdateResults('/Applications/XR Collector.app/Contents/Resources/bin/xr-mac-update-helper', current,
    { record, report: vi.fn() }, { platform: 'darwin', contexts: async () => [{ workDir, request }], runHelper });
  expect(runHelper).toHaveBeenCalledTimes(1);
  expect(recovered).toBe(true);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ token: 'late-run', phase: 'succeeded' }));
  await rm(workDir, { recursive: true, force: true });
});

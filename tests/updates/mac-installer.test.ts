import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { nativeRecoveryReceipt, preparedMacHandoff, recoverMacUpdateResults, validateMacUpdateArchive } from '../../src/updates/mac-installer.js';

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
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs'), path=require('node:path'), root=process.argv[1];
    const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'handoff.json'))){
      setTimeout(()=>{fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({phase:'waiting_for_exit'}));setTimeout(()=>process.exit(0),200)},80);
      clearInterval(timer);
    }},5);
  `, workDir]);
  const prepared = preparedMacHandoff({ workDir, runId: 'run', nonce: 'n'.repeat(64), parentPid: process.pid,
    expectedVersion: '0.1.2', expectedBuildId: 'build-b', child, signal: new AbortController().signal, abort: vi.fn() });
  let completed = false; const handingOff = prepared.handoff().then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 30)); expect(completed).toBe(false);
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

// Finalize runs the packaged helper as an executable `#!/usr/bin/env node` script, which only a POSIX host can start.
it.skipIf(process.platform === 'win32')('keeps a terminal journal until finalize and never finalizes recovery-required evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xr-mac-recovery-'));
  const resources = path.join(root, 'resources'); const workDir = path.join(root, '.xr-update-run');
  await mkdir(path.join(resources, 'bin'), { recursive: true }); await mkdir(workDir);
  const helper = path.join(resources, 'bin', 'xr-mac-update-helper');
  await writeFile(helper, `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
if(process.argv[2]!=='--cleanup')process.exit(2);
fs.rmSync(path.dirname(process.argv[3]),{recursive:true,force:true});
`); await chmod(helper, 0o755);
  const request = { runId: 'run-id', previousVersion: '0.1.1', previousBuildId: 'build-a',
    expectedVersion: '0.1.2', expectedBuildId: 'build-b' };
  await writeFile(path.join(workDir, 'request.json'), JSON.stringify(request));
  const rolledBack = nativeRecoveryReceipt(workDir, request, { schemaVersion: 1, runId: 'run-id', phase: 'rolled_back', reason: 'startup_failed' }, resources)!;
  expect(rolledBack).toMatchObject({ token: 'run-id', phase: 'rolled_back', reason: 'startup_failed' });
  await expect(stat(workDir)).resolves.toBeDefined();
  await rolledBack.finalize();
  await expect(stat(workDir)).rejects.toMatchObject({ code: 'ENOENT' });

  const retained = path.join(root, '.xr-update-retained'); await mkdir(retained);
  await writeFile(path.join(retained, 'request.json'), JSON.stringify(request));
  const recoveryRequired = nativeRecoveryReceipt(retained, request, { schemaVersion: 1, runId: 'run-id', phase: 'recovery_required' }, resources)!;
  await expect(recoveryRequired.finalize()).rejects.toThrow('不可自動清除');
  await expect(stat(retained)).resolves.toBeDefined();
  await rm(root, { recursive: true, force: true });
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
  const current = { schemaVersion: 1, kind: 'packaged', version: '0.1.2', buildId: 'build-b', builtAt: new Date().toISOString(),
    commit: 'a'.repeat(40), target: 'darwin-arm64', sourceDirty: false } as const;
  const recovered = await recoverMacUpdateResults('/Applications/XR Collector.app/Contents/Resources', current, {
    platform: 'darwin', contexts: async () => [{ workDir, request }], runHelper,
  });
  expect(runHelper).toHaveBeenCalledTimes(1);
  expect(recovered).toMatchObject({ launchReady: true, results: [{ token: 'late-run', phase: 'succeeded' }] });
  await rm(workDir, { recursive: true, force: true });
});

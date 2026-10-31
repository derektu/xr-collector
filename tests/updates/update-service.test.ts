import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { UpdateOffer } from '../../src/core/types.js';
import { UpdateService } from '../../src/updates/update-service.js';
import type { UpdateApplyRequest } from '../../src/updates/types.js';

const payload = Buffer.from('real package bytes');
const offer: UpdateOffer = {
  version: '0.1.1', commit: 'a'.repeat(40), target: 'darwin-arm64', releaseNotes: 'notes',
  source: { id: 'test', indexUrl: 'https://example.test/index.json' },
  payload: { name: 'app.zip', url: 'https://example.test/v0.1.1/app.zip', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') },
  buildInfo: { schemaVersion: 1, kind: 'packaged', version: '0.1.1', builtAt: '2026-10-26T00:00:00.000Z', commit: 'a'.repeat(40), buildId: 'b', target: 'darwin-arm64', sourceDirty: false },
};
const identity = { version: '0.1.0', target: 'darwin-arm64' };

it('checks without downloading, pins an offer, verifies the stream, and restores ready state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const source = { id: 'test', check: vi.fn(async () => offer) };
  const installer = { available: true, validate: vi.fn(async () => undefined) };
  const request = vi.fn(async () => new Response(payload));
  const first = await UpdateService.open({ identity, source, installer, directory, request: request as typeof fetch });
  expect((await first.check()).phase).toBe('available'); expect(request).not.toHaveBeenCalled();
  expect((await first.download({ version: offer.version, sha256: offer.payload.sha256 })).phase).toBe('ready');
  expect(Object.keys(JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'))).sort()).toEqual(['attempt', 'checkedAt', 'lastCheckAttemptAt', 'ready', 'schemaVersion']);
  const restarted = await UpdateService.open({ identity, source, installer, directory, request: request as typeof fetch });
  expect(restarted.status()).toMatchObject({ phase: 'ready', ready: { version: '0.1.1' } });
  expect(request).toHaveBeenCalledTimes(1);
});

it('never marks a truncated or modified file ready and keeps an older ready offer during a later failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const source = { id: 'test', check: async () => offer };
  const installer = { available: true, validate: async () => undefined };
  const broken = await UpdateService.open({ identity, source, installer, directory, request: async () => new Response(payload.subarray(0, 3)) });
  await broken.check(); expect((await broken.download({ version: offer.version, sha256: offer.payload.sha256 })).phase).toBe('error');
  expect(broken.status().errorCode).toBe('update_integrity_failed');

  const good = await UpdateService.open({ identity, source, installer, directory, request: async () => new Response(payload) });
  await good.check(); await good.download({ version: offer.version, sha256: offer.payload.sha256 });
  const readyState = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  const readyFile = path.join(directory, 'cache', readyState.ready.fileName);
  await writeFile(readyFile, 'tampered');
  const restarted = await UpdateService.open({ identity, source, installer, directory });
  expect(restarted.status()).toMatchObject({ ready: null, phase: 'idle', message: '已清除無效的更新快取，請重新下載。' });
});

it('requires a separate explicit apply and cancellation does not consume ready bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-')); let requestSignal: AbortSignal | null = null;
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer },
    installer: { available: true, validate: async () => undefined }, directory,
    request: async () => new Response(payload), apply: (request) => { requestSignal = request.signal; } });
  const selection = { version: offer.version, sha256: offer.payload.sha256 };
  await service.check(); await service.download(selection);
  expect(service.status().phase).toBe('ready'); expect((await service.apply(selection)).phase).toBe('waiting');
  expect((await service.cancel()).phase).toBe('ready'); expect(requestSignal?.aborted).toBe(true);
});

it('releases failed apply validation so the verified package can be retried', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const validate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('native preflight failed')).mockResolvedValue(undefined);
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer },
    installer: { available: true, validate }, directory, request: async () => new Response(payload) });
  const selection = { version: offer.version, sha256: offer.payload.sha256 };
  await service.check(); await service.download(selection);
  await expect(service.apply(selection)).rejects.toThrow('native preflight failed');
  expect(service.status().phase).toBe('ready');
  expect((await service.apply(selection)).phase).toBe('error');
  expect(validate).toHaveBeenCalledTimes(3);
});

it('clears a ready package changed before apply and lets the same pinned offer download again', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer },
    installer: { available: true, validate: async () => undefined }, directory,
    request: async () => new Response(payload) });
  const selection = { version: offer.version, sha256: offer.payload.sha256 };
  await service.check(); await service.download(selection);
  const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  await writeFile(path.join(directory, 'cache', saved.ready.fileName), 'tampered');
  await expect(service.apply(selection)).rejects.toMatchObject({ code: 'update_integrity_failed' });
  expect(service.status()).toMatchObject({ phase: 'available', ready: null, offer: { version: offer.version } });
  expect((await service.download(selection)).phase).toBe('ready');
});

it('cancels a partial download without losing its pinned offer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer },
    installer: { available: true, validate: async () => undefined }, directory,
    request: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch });
  const selection = { version: offer.version, sha256: offer.payload.sha256 };
  await service.check(); const work = service.download(selection);
  await vi.waitFor(() => expect(service.status().phase).toBe('downloading'));
  expect((await service.cancel()).phase).toBe('available');
  await expect(work).resolves.toMatchObject({ phase: 'available', offer: { version: offer.version } });
});

it('keeps the verified ready version pinned while a newly discovered version downloads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const nextBytes = Buffer.from('newer package bytes');
  const newer: UpdateOffer = { ...offer, version: '0.1.2',
    payload: { ...offer.payload, url: 'https://example.test/v0.1.2/app.zip', bytes: nextBytes.length,
      sha256: createHash('sha256').update(nextBytes).digest('hex') },
    buildInfo: { ...offer.buildInfo, version: '0.1.2', buildId: 'c' } };
  let checks = 0;
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => ++checks === 1 ? offer : newer },
    installer: { available: true, validate: async () => undefined }, directory,
    request: ((_input: RequestInfo | URL, init?: RequestInit) => checks === 1 ? Promise.resolve(new Response(payload))
      : new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))) as typeof fetch });
  await service.check(); await service.download({ version: offer.version, sha256: offer.payload.sha256 });
  expect((await service.check())).toMatchObject({ phase: 'ready', ready: { version: '0.1.1' }, offer: { version: '0.1.2' } });
  const downloading = service.download({ version: newer.version, sha256: newer.payload.sha256 });
  await vi.waitFor(() => expect(service.status()).toMatchObject({ phase: 'downloading', ready: { version: '0.1.1' }, offer: { version: '0.1.2' } }));
  await service.cancel(); await downloading;
  expect(service.status()).toMatchObject({ phase: 'ready', ready: { version: '0.1.1' }, offer: { version: '0.1.2' } });
});

it('finishes an in-flight check before accepting a selection so stale UI cannot start a download', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  let finish!: (value: UpdateOffer) => void; let checks = 0;
  const newer = { ...offer, version: '0.1.2', payload: { ...offer.payload, sha256: 'c'.repeat(64) } };
  const source = { id: 'test', check: async () => ++checks === 1 ? offer : new Promise<UpdateOffer>((resolve) => { finish = resolve; }) };
  const request = vi.fn(async () => new Response(payload));
  const service = await UpdateService.open({ identity, source,
    installer: { available: true, validate: async () => undefined }, directory, request });
  await service.check(); const checking = service.check();
  const download = service.download({ version: offer.version, sha256: offer.payload.sha256 });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  finish(newer); await checking;
  await expect(download).rejects.toMatchObject({ code: 'update_offer_changed' });
  expect(request).not.toHaveBeenCalled();
});

it('persists an install attempt before handoff and confirms it only from the running build identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-')); let applying!: UpdateApplyRequest;
  const first = await UpdateService.open({ identity, currentBuildId: 'build-a', source: { id: 'test', check: async () => offer },
    installer: { available: true, validate: async () => undefined }, directory,
    request: async () => new Response(payload), apply: (request) => { applying = request; } });
  const selection = { version: offer.version, sha256: offer.payload.sha256 };
  await first.check(); await first.download(selection); await first.apply(selection); await applying.recordAttempt(); applying.installing();
  expect(first.status().lastAttempt).toMatchObject({ version: '0.1.1', outcome: 'pending' });

  const events: string[] = [];
  const next = await UpdateService.open({ identity: { ...identity, version: '0.1.1' }, currentBuildId: offer.buildInfo.buildId,
    source: { id: 'test', check: async () => null }, installer: { available: true, validate: async () => undefined }, directory,
    event: (_severity, type) => events.push(type) });
  expect(next.status().lastAttempt).toMatchObject({ version: '0.1.1', outcome: 'pending' });
  expect(next.status().message).not.toContain('無效');
  await next.confirmRunningBuild();
  expect(next.status()).toMatchObject({ message: '已安裝 0.1.1。', ready: null,
    lastAttempt: { version: '0.1.1', outcome: 'succeeded', message: '已安裝 0.1.1。' } });
  expect(next.status().message).not.toContain('無效');
  expect(events).toContain('device.update_installed');
});

it('does not replace a newer ready-version message when confirming the running build', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const newerPayload = Buffer.from('newer package bytes');
  const newer: UpdateOffer = { ...offer, version: '0.1.2',
    payload: { ...offer.payload, url: 'https://example.test/v0.1.2/app.zip', bytes: newerPayload.length,
      sha256: createHash('sha256').update(newerPayload).digest('hex') },
    buildInfo: { ...offer.buildInfo, version: '0.1.2', buildId: 'newer-build' } };
  const current = { ...identity, version: '0.1.1' };
  const first = await UpdateService.open({ identity: current, currentBuildId: 'current-build',
    source: { id: 'test', check: async () => newer }, installer: { available: true, validate: async () => undefined },
    directory, request: async () => new Response(newerPayload) });
  await first.check(); await first.download({ version: newer.version, sha256: newer.payload.sha256 });
  const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  saved.attempt = { id: 'current-install', version: current.version, buildId: 'current-build', startedAt: new Date().toISOString(),
    finishedAt: null, outcome: 'pending', message: `正在安裝 ${current.version}。`, previousVersion: '0.1.0',
    previousBuildId: 'previous-build', eventRecorded: false };
  await writeFile(path.join(directory, 'state.json'), JSON.stringify(saved));

  const restarted = await UpdateService.open({ identity: current, currentBuildId: 'current-build',
    source: { id: 'test', check: async () => newer }, installer: { available: true, validate: async () => undefined }, directory });
  expect(restarted.status()).toMatchObject({ phase: 'ready', message: '0.1.2 已準備好。', ready: { version: '0.1.2' } });
  await restarted.confirmRunningBuild();
  expect(restarted.status()).toMatchObject({ phase: 'ready', message: '0.1.2 已準備好。', ready: { version: '0.1.2' },
    lastAttempt: { version: '0.1.1', outcome: 'succeeded', message: '已安裝 0.1.1。' } });
});

it('cleans orphan, partial, directory and symlink cache entries while preserving only the verified ready payload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-cache-cleanup-'));
  const installer = { available: true, validate: async () => undefined };
  const first = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer }, installer, directory,
    request: async () => new Response(payload) });
  const cache = path.join(directory, 'cache');
  await writeFile(path.join(cache, 'preexisting-orphan.bin'), 'orphan');
  await writeFile(path.join(cache, 'preexisting.part'), 'partial');
  await first.check(); await first.download({ version: offer.version, sha256: offer.payload.sha256 });
  const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  expect(await readdir(cache)).toEqual([saved.ready.fileName]);
  await writeFile(path.join(cache, 'orphan.bin'), 'orphan');
  await writeFile(path.join(cache, 'interrupted.part'), 'partial');
  await mkdir(path.join(cache, 'orphan-dir')); await writeFile(path.join(cache, 'orphan-dir/file'), 'orphan');
  const outside = path.join(directory, 'outside'); await writeFile(outside, 'keep');
  await symlink(outside, path.join(cache, 'outside-link'));

  await UpdateService.open({ identity, source: { id: 'test', check: async () => offer }, installer, directory });
  expect(await readdir(cache)).toEqual([saved.ready.fileName]);
  expect(await readFile(outside, 'utf8')).toBe('keep');
});

it('cleans an ownerless cache inventory on first start even when state.json does not exist', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-first-cache-cleanup-'));
  const cache = path.join(directory, 'cache'); await mkdir(cache, { mode: 0o700 });
  await writeFile(path.join(cache, 'orphan.bin'), 'orphan');
  await writeFile(path.join(cache, 'interrupted.part'), 'partial');
  const outside = path.join(directory, 'outside'); await writeFile(outside, 'keep');
  await symlink(outside, path.join(cache, 'outside-link'));

  await UpdateService.open({ identity, source: { id: 'test', check: async () => null },
    installer: { available: true, validate: async () => undefined }, directory });
  expect(await readdir(cache)).toEqual([]);
  expect(await readFile(outside, 'utf8')).toBe('keep');
  expect(JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, ready: null });
});

it.each(['EPERM', 'EBUSY'])('defers a Windows file-in-use cache removal (%s) without invalidating a successful update', async (code) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-locked-cache-'));
  const cache = path.join(directory, 'cache'); await mkdir(cache, { mode: 0o700 });
  const oldInstaller = path.join(cache, 'old-installer.exe'); await writeFile(oldInstaller, 'old installer');
  const windowsIdentity = { ...identity, target: 'win32-x64' };
  const installedOffer = { ...offer, version: windowsIdentity.version, target: windowsIdentity.target,
    buildInfo: { ...offer.buildInfo, version: identity.version } };
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 1,
    ready: { offer: installedOffer, fileName: path.basename(oldInstaller) }, attempt: null,
    lastCheckAttemptAt: null, checkedAt: null }));
  const removeCacheEntry = vi.fn(async (target: string, options: { recursive?: boolean; force?: boolean }) => {
    if (target === oldInstaller) throw Object.assign(new Error('installer still running'), { code });
    await rm(target, options);
  });

  const first = await UpdateService.open({ identity: windowsIdentity, source: { id: 'test', check: async () => null },
    installer: { available: true, validate: async () => undefined }, directory, removeCacheEntry });
  expect(first.status()).toMatchObject({ phase: 'idle', ready: null });
  expect(first.status().message).not.toContain('無效');
  expect(await readFile(oldInstaller, 'utf8')).toBe('old installer');
  await first.close();

  const next = await UpdateService.open({ identity: windowsIdentity, source: { id: 'test', check: async () => null },
    installer: { available: true, validate: async () => undefined }, directory });
  expect(await readdir(cache)).toEqual([]);
  expect(next.status().message).not.toContain('無效');
});

it('downloads a same-version offer again when its immutable payload SHA changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-replaced-'));
  const replacementBytes = Buffer.from('replacement package');
  const replacement = { ...offer, payload: { ...offer.payload, bytes: replacementBytes.length,
    sha256: createHash('sha256').update(replacementBytes).digest('hex') } };
  let checks = 0; let downloads = 0;
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => ++checks === 1 ? offer : replacement },
    installer: { available: true, validate: async () => undefined }, directory,
    request: async () => new Response(++downloads === 1 ? payload : replacementBytes) });
  await service.check(); await service.download({ version: offer.version, sha256: offer.payload.sha256 });
  await service.check(); await service.download({ version: replacement.version, sha256: replacement.payload.sha256 });
  expect(downloads).toBe(2);
  expect(service.status().ready?.payload.sha256).toBe(replacement.payload.sha256);
});

it('times out before response headers and while a response body is stalled, cleaning every part file', async () => {
  vi.useFakeTimers();
  try {
    let streamCancelled = false;
    for (const request of [
      ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))) as typeof fetch,
      (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 2)); }, cancel() { streamCancelled = true; } }))) as typeof fetch,
    ]) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-timeout-'));
      const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer },
        installer: { available: true, validate: async () => undefined }, directory, request, downloadIdleTimeoutMs: 50 });
      await service.check(); const download = service.download({ version: offer.version, sha256: offer.payload.sha256 });
      await vi.advanceTimersByTimeAsync(51); await download;
      expect(service.status()).toMatchObject({ phase: 'error', errorCode: 'update_download_timeout' });
      expect((await readdir(path.join(directory, 'cache'))).filter((name) => name.endsWith('.part'))).toEqual([]);
    }
    expect(streamCancelled).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('stops the network idle timer at body EOF so slow native validation is not treated as a download timeout', async () => {
  vi.useFakeTimers();
  try {
    let finishValidation!: () => void;
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    const validation = new Promise<void>((resolve) => { finishValidation = resolve; });
    const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer },
      installer: { available: true, validate: async () => { validationStarted(); return validation; } }, directory: await mkdtemp(path.join(os.tmpdir(), 'xr-update-validate-')),
      request: async () => new Response(payload), downloadIdleTimeoutMs: 50 });
    await service.check(); const download = service.download({ version: offer.version, sha256: offer.payload.sha256 });
    await started;
    await vi.advanceTimersByTimeAsync(500);
    expect(service.status()).toMatchObject({ phase: 'verifying', errorCode: null });
    finishValidation(); await download;
    expect(service.status().phase).toBe('ready');
  } finally { vi.useRealTimers(); }
});

it('records both check timestamps and emits only terminal check transitions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-check-state-'));
  const events: string[] = [];
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => { throw new Error('offline'); } },
    installer: { available: true, validate: async () => undefined }, directory, event: (_severity, type) => events.push(type) });
  await service.check(); const firstAttempt = service.status().lastCheckAttemptAt;
  await service.check();
  expect(firstAttempt).not.toBeNull();
  expect(service.status()).toMatchObject({ checkedAt: null, lastCheckAttemptAt: expect.any(String) });
  expect(events).toEqual(['device.update_check_failed']);
});

it('emits the same failure or offer again only after a successful up-to-date transition', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-check-transitions-'));
  const results: Array<'fail' | null | UpdateOffer> = ['fail', 'fail', null, 'fail', offer, offer, null, offer];
  const events: string[] = [];
  const service = await UpdateService.open({ identity, source: { id: 'test', check: async () => {
    const result = results.shift(); if (result === 'fail') throw new Error('offline'); return result ?? null;
  } }, installer: { available: true, validate: async () => undefined }, directory,
  event: (_severity, type) => events.push(type) });
  for (let index = 0; index < 8; index += 1) await service.check();
  expect(events).toEqual(['device.update_check_failed', 'device.update_check_failed', 'device.update_available', 'device.update_available']);
});

it('consumes native recovery only with exact token and A/B identities', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-recovery-')); let applying!: UpdateApplyRequest;
  const first = await UpdateService.open({ identity, currentBuildId: 'build-a', source: { id: 'test', check: async () => offer },
    installer: { available: true, validate: async () => undefined }, directory, request: async () => new Response(payload),
    apply: (request) => { applying = request; } });
  await first.check(); await first.download({ version: offer.version, sha256: offer.payload.sha256 });
  await first.apply({ version: offer.version, sha256: offer.payload.sha256 }); await applying.recordAttempt('native-run');
  const next = await UpdateService.open({ identity: { ...identity, version: offer.version }, currentBuildId: offer.buildInfo.buildId,
    source: { id: 'test', check: async () => null }, installer: { available: true, validate: async () => undefined }, directory });
  const recovery = { token: 'native-run', phase: 'succeeded' as const, previousVersion: identity.version, previousBuildId: 'build-a',
    expectedVersion: offer.version, expectedBuildId: offer.buildInfo.buildId, finalize: async () => undefined };
  expect(await next.consumeNativeRecovery({ ...recovery, token: 'wrong' })).toBe(false);
  expect(await next.consumeNativeRecovery(recovery)).toBe(true);
  expect(next.status().lastAttempt).toMatchObject({ outcome: 'succeeded', message: '已安裝 0.1.1。' });
  expect(await next.consumeNativeRecovery(recovery)).toBe(true);
});

it('records an exact rollback recovery as failed only while the previous build is running', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-rollback-'));
  await mkdir(path.join(directory, 'cache'));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 1, ready: null, checkedAt: null, lastCheckAttemptAt: null,
    attempt: { id: 'rollback-run', version: offer.version, buildId: offer.buildInfo.buildId, startedAt: new Date().toISOString(), finishedAt: null,
      outcome: 'pending', message: 'installing', previousVersion: identity.version, previousBuildId: 'build-a', eventRecorded: false } }));
  const service = await UpdateService.open({ identity, currentBuildId: 'build-a', source: { id: 'test', check: async () => null },
    installer: { available: true, validate: async () => undefined }, directory });
  const result = { token: 'rollback-run', phase: 'rolled_back' as const, previousVersion: identity.version, previousBuildId: 'build-a',
    expectedVersion: offer.version, expectedBuildId: offer.buildInfo.buildId, reason: 'helper restored A', finalize: async () => undefined };
  expect(await service.consumeNativeRecovery({ ...result, phase: 'recovery_required' })).toBe(false);
  expect(await service.consumeNativeRecovery(result)).toBe(true);
  expect(service.status().lastAttempt).toMatchObject({ outcome: 'failed', message: expect.stringContaining('已還原') });
});

it('marks a Windows-style pending attempt unknown only after the previous build is fully running', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-windows-unknown-'));
  await mkdir(path.join(directory, 'cache'));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 1, ready: null, checkedAt: null, lastCheckAttemptAt: null,
    attempt: { id: 'nsis-run', version: offer.version, buildId: offer.buildInfo.buildId, startedAt: new Date().toISOString(), finishedAt: null,
      outcome: 'pending', message: 'installing', previousVersion: identity.version, previousBuildId: 'build-a', eventRecorded: false } }));
  const events: string[] = [];
  const service = await UpdateService.open({ identity, currentBuildId: 'build-a', source: { id: 'test', check: async () => null },
    installer: { available: true, validate: async () => undefined }, directory, event: (_severity, type) => events.push(type) });
  expect(service.status().lastAttempt?.outcome).toBe('pending');
  await service.confirmRunningBuild();
  expect(service.status().lastAttempt).toMatchObject({ outcome: 'unknown', message: '無法確認 0.1.1 的安裝結果。' });
  expect(events).toEqual(['device.update_outcome_unknown']);
  expect(JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')).attempt.outcome).toBe('unknown');

  const expected = await UpdateService.open({ identity: { ...identity, version: offer.version }, currentBuildId: offer.buildInfo.buildId,
    source: { id: 'test', check: async () => null }, installer: { available: true, validate: async () => undefined }, directory });
  await expected.confirmRunningBuild();
  expect(expected.status().lastAttempt).toMatchObject({ outcome: 'succeeded', message: '已安裝 0.1.1。' });
});

it('persists matching recovery-required state without finalizing or later inferring success', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-recovery-required-'));
  await mkdir(path.join(directory, 'cache'));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 1, ready: null, checkedAt: null, lastCheckAttemptAt: null,
    attempt: { id: 'manual-run', version: offer.version, buildId: offer.buildInfo.buildId, startedAt: new Date().toISOString(), finishedAt: null,
      outcome: 'pending', message: 'installing', previousVersion: identity.version, previousBuildId: 'build-a', eventRecorded: false } }));
  const service = await UpdateService.open({ identity: { ...identity, version: offer.version }, currentBuildId: offer.buildInfo.buildId,
    source: { id: 'test', check: async () => null }, installer: { available: true, validate: async () => undefined }, directory });
  let finalized = false;
  const recovery = { token: 'manual-run', phase: 'recovery_required' as const, previousVersion: identity.version, previousBuildId: 'build-a',
    expectedVersion: offer.version, expectedBuildId: offer.buildInfo.buildId, reason: 'manual repair needed', finalize: async () => { finalized = true; } };
  expect(await service.consumeNativeRecovery(recovery)).toBe(false);
  expect(finalized).toBe(false);
  expect(service.status().lastAttempt).toMatchObject({ outcome: 'unknown', message: expect.stringContaining('人工復原') });
  await service.confirmRunningBuild();
  expect(service.status().lastAttempt?.outcome).toBe('unknown');
});

it('does not consume or finalize native recovery until the result is durably saved and remains retryable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-recovery-save-'));
  await mkdir(path.join(directory, 'cache'));
  const stateFile = path.join(directory, 'state.json');
  const pending = { id: 'retry-run', version: offer.version, buildId: offer.buildInfo.buildId, startedAt: new Date().toISOString(), finishedAt: null,
    outcome: 'pending', message: 'installing', previousVersion: identity.version, previousBuildId: 'build-a', eventRecorded: false };
  await writeFile(stateFile, JSON.stringify({ schemaVersion: 1, ready: null, checkedAt: null, lastCheckAttemptAt: null, attempt: pending }));
  const service = await UpdateService.open({ identity: { ...identity, version: offer.version }, currentBuildId: offer.buildInfo.buildId,
    source: { id: 'test', check: async () => null }, installer: { available: true, validate: async () => undefined }, directory });
  let finalized = 0;
  const result = { token: pending.id, phase: 'succeeded' as const, previousVersion: identity.version, previousBuildId: 'build-a',
    expectedVersion: offer.version, expectedBuildId: offer.buildInfo.buildId, finalize: async () => { finalized += 1; } };
  await rm(stateFile); await mkdir(stateFile);
  await expect(service.consumeNativeRecovery(result)).rejects.toThrow();
  expect(service.status().lastAttempt?.outcome).toBe('pending');
  expect(finalized).toBe(0);
  await rm(stateFile, { recursive: true });
  expect(await service.consumeNativeRecovery(result)).toBe(true);
  await result.finalize();
  expect(finalized).toBe(1);
  expect(JSON.parse(await readFile(stateFile, 'utf8')).attempt.outcome).toBe('succeeded');
});

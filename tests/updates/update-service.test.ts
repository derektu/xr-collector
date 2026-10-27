import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { UpdateOffer } from '../../src/core/types.js';
import { UpdateService } from '../../src/updates/update-service.js';
import type { UpdateApplyRequest } from '../../src/updates/types.js';

const payload = Buffer.from('real package bytes');
const offer: UpdateOffer = {
  version: '0.1.1', commit: 'a'.repeat(40), target: 'darwin-arm64', variant: 'chinese', releaseNotes: 'notes',
  source: { id: 'test', indexUrl: 'https://example.test/index.json' },
  payload: { name: 'app.zip', url: 'https://example.test/v0.1.1/app.zip', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') },
  manifest: { name: 'manifest.json', url: 'https://example.test/v0.1.1/manifest.json', bytes: 1, sha256: 'b'.repeat(64) },
  buildInfo: { schemaVersion: 1, kind: 'packaged', version: '0.1.1', builtAt: '2026-10-26T00:00:00.000Z', commit: 'a'.repeat(40), buildId: 'b', target: 'darwin-arm64', variant: 'chinese', sourceDirty: false },
};
const identity = { version: '0.1.0', target: 'darwin-arm64', variant: 'chinese' as const };

it('checks without downloading, pins an offer, verifies the stream, and restores ready state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const source = { id: 'test', check: vi.fn(async () => offer) };
  const installer = { available: true, validate: vi.fn(async () => undefined) };
  const request = vi.fn(async () => new Response(payload));
  const notifications: string[] = [];
  const first = await UpdateService.open({ identity, source, installer, directory, request: request as typeof fetch, notify: (kind) => notifications.push(kind) });
  expect((await first.check()).phase).toBe('available'); expect(request).not.toHaveBeenCalled();
  expect((await first.download({ version: offer.version, sha256: offer.payload.sha256 })).phase).toBe('ready'); expect(notifications).toEqual(['available', 'ready']);
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
  expect(restarted.status().ready).toBeNull(); expect(restarted.status().phase).toBe('idle');
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
  finish(newer); await checking;
  await expect(download).rejects.toMatchObject({ code: 'update_offer_changed' });
  expect(request).not.toHaveBeenCalled();
});

it('notifies each stable version once even when the source regresses and the service restarts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const second: UpdateOffer = { ...offer, version: '0.1.2', buildInfo: { ...offer.buildInfo, version: '0.1.2' } };
  const sequence = [offer, second, offer]; const notices: string[] = [];
  const first = await UpdateService.open({ identity, source: { id: 'test', check: async () => sequence.shift() ?? offer },
    installer: { available: true, validate: async () => undefined }, directory,
    notify: (kind, found) => notices.push(`${kind}:${found.version}`) });
  await first.check(); await first.check(); await first.check();
  const restarted = await UpdateService.open({ identity, source: { id: 'test', check: async () => offer },
    installer: { available: true, validate: async () => undefined }, directory,
    notify: (kind, found) => notices.push(`${kind}:${found.version}`) });
  await restarted.check();
  expect(notices).toEqual(['available:0.1.1', 'available:0.1.2']);
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
  await next.confirmRunningBuild();
  expect(next.status().lastAttempt).toMatchObject({ version: '0.1.1', outcome: 'succeeded' });
  expect(events).toContain('device.update_installed');
});

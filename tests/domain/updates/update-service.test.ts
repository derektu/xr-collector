// Broken, people stay on an old build, install something they did not choose, or see an install
// that never happened.
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UpdateOffer } from '../../../src/shared/api/update-types.js';
import { UpdateService, type AppUpdater, type UpdateServiceOptions } from '../../../src/domain/updates/index.js';

const offer: UpdateOffer = { version: '0.1.2' };

class FakeUpdater implements AppUpdater {
  readonly available = true;
  downloads: Array<{ progress: (transferred: number, total: number) => void; signal: AbortSignal; finish: () => void; fail: (error: Error) => void }> = [];
  constructor(public found: () => Promise<UpdateOffer | null> = async () => offer) {}
  check(): Promise<UpdateOffer | null> { return this.found(); }
  download(progress: (transferred: number, total: number) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      this.downloads.push({ progress, signal, finish: resolve, fail: reject });
    });
  }
}

async function open(options: Partial<UpdateServiceOptions> = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
  const events: string[] = [];
  const updater = (options.updater ?? new FakeUpdater()) as FakeUpdater;
  const service = await UpdateService.open({
    updater, currentVersion: '0.1.1', target: 'darwin-arm64', directory, restartToInstall: () => undefined,
    event: (_severity, type, message) => events.push(`${type}: ${message}`), ...options,
  });
  return { service, updater, directory, events };
}

async function ready(options: Partial<UpdateServiceOptions> = {}) {
  const opened = await open(options);
  await opened.service.check();
  const download = opened.service.download({ version: offer.version });
  opened.updater.downloads[0]!.finish();
  await download;
  return opened;
}

const failure = (code?: string): Error => Object.assign(new Error('Cannot find latest-mac.yml in the latest release artifacts\nHttpError: 404'), { code });

describe('checking for an update', () => {
  it.each<[string, () => Promise<UpdateOffer | null>, object]>([
    ['a newer release', async () => offer, { phase: 'available', offer, errorCode: null, message: '有新版本 0.1.2' }],
    ['no newer release', async () => null, { phase: 'up_to_date', offer: null, errorCode: null }],
    ['a release without this platform\'s feed yet', async () => { throw failure('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'); }, { phase: 'up_to_date', offer: null, errorCode: null }],
    ['an unreachable source', async () => { throw failure('ERR_UPDATER_LATEST_VERSION_NOT_FOUND'); }, { phase: 'error', errorCode: 'update_source_failed', message: '無法檢查更新，請稍後再試。', detail: 'Cannot find latest-mac.yml in the latest release artifacts' }],
  ])('reports %s', async (_case, found, expected) => {
    const { service } = await open({ updater: new FakeUpdater(found) });
    expect(await service.check()).toMatchObject(expected);
  });

  it('keeps the updater\'s own words of a failed check in the activity log, beside the short message the person reads', async () => {
    const { service, events } = await open({ updater: new FakeUpdater(async () => { throw failure(); }) });
    await service.check();
    expect(events).toEqual(['device.update_check_failed: Cannot find latest-mac.yml in the latest release artifacts']);
  });

  it('keeps when it last tried across restarts, which paces the daily automatic check', async () => {
    const at = new Date('2026-11-24T01:00:00.000Z');
    const first = await open({ now: () => at, updater: new FakeUpdater(async () => { throw failure(); }) });
    await first.service.check();
    const restarted = await open({ directory: first.directory });
    expect(restarted.service.status()).toMatchObject({ lastCheckAttemptAt: at.toISOString(), checkedAt: null });
  });
});

describe('downloading an update', () => {
  it('offers the release for install only once the download finishes, reporting progress meanwhile', async () => {
    const { service, updater, events } = await open();
    await service.check();
    const download = service.download({ version: offer.version });
    updater.downloads[0]!.progress(62, 100);
    expect(service.status()).toMatchObject({ phase: 'downloading', ready: null, progress: { transferred: 62, total: 100, percent: 62 }, message: '下載中 62%' });
    updater.downloads[0]!.finish();
    expect(await download).toMatchObject({ phase: 'ready', ready: offer, progress: null, message: '可安裝 0.1.2' });
    expect(events).toContain('device.update_ready: 版本 0.1.2 已下載。');
  });

  it('returns to the same offer when cancelled, and to an error with nothing installable when the download fails', async () => {
    const { service, updater, events } = await open();
    await service.check();
    const cancelled = service.download({ version: offer.version });
    await service.cancel();
    expect(await cancelled).toMatchObject({ phase: 'available', offer, ready: null, errorCode: null });
    const failed = service.download({ version: offer.version });
    updater.downloads[1]!.fail(new Error('sha512 checksum mismatch'));
    expect(await failed).toMatchObject({ phase: 'error', ready: null, errorCode: 'update_download_failed', message: '下載失敗，請重新下載。', detail: 'sha512 checksum mismatch' });
    expect(events).toContain('device.update_download_failed: sha512 checksum mismatch');
  });

  it('downloads only the version the person chose', async () => {
    const { service } = await open();
    await expect(service.download({ version: offer.version })).rejects.toMatchObject({ code: 'update_not_available' });
    await service.check();
    await expect(service.download({ version: '0.1.3' })).rejects.toMatchObject({ code: 'update_offer_changed' });
  });

  it('gives up the installable release when a newer download starts, because the updater replaces the downloaded file', async () => {
    const { service, updater } = await ready();
    updater.found = async () => ({ version: '0.1.3' });
    expect(await service.check()).toMatchObject({ phase: 'ready', ready: offer, offer: { version: '0.1.3' } });
    void service.download({ version: '0.1.3' });
    expect(service.status()).toMatchObject({ phase: 'downloading', ready: null });
  });
});

describe('installing an update', () => {
  it('installs only a downloaded release the person chose', async () => {
    const { service } = await open();
    await service.check();
    await expect(service.apply({ version: offer.version })).rejects.toMatchObject({ code: 'update_not_ready' });
    const downloaded = await ready();
    await expect(downloaded.service.apply({ version: '0.1.3' })).rejects.toMatchObject({ code: 'update_offer_changed' });
  });

  it('records the version being installed before the App quits to install it', async () => {
    let recorded: unknown;
    const { service, directory } = await ready({
      restartToInstall: () => { recorded = JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8')).installing; },
    });
    expect(await service.apply({ version: offer.version })).toMatchObject({ phase: 'installing' });
    expect(recorded).toEqual({ version: offer.version, failure: null });
  });

  it.each([
    ['the installed version is running', '0.1.2', null, { outcome: 'installed', detail: null }, 'device.update_installed'],
    ['the previous version is still running', '0.1.1', null, { outcome: 'incomplete', detail: null }, 'device.update_incomplete'],
    ['the installer refused the update', '0.1.1', 'code failed to satisfy specified code requirement(s)',
      { outcome: 'incomplete', detail: 'code failed to satisfy specified code requirement(s)' }, 'device.update_incomplete'],
  ] as const)('on the next start, records the install when %s', async (_case, runningVersion, failureReason, result, event) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'xr-update-service-'));
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ lastCheckAttemptAt: null, checkedAt: null, installing: { version: '0.1.2', failure: failureReason } }));
    const restarted = await open({ directory, currentVersion: runningVersion });
    const attempt = restarted.service.status().lastAttempt;
    expect(attempt).toMatchObject({ version: '0.1.2', ...result });
    expect(restarted.service.status().message === attempt?.message).toBe(result.outcome === 'installed');
    expect(restarted.events).toHaveLength(1);
    expect(restarted.events[0]?.startsWith(`${event}: `)).toBe(true);
    if (failureReason) {
      expect(attempt?.message.includes(failureReason)).toBe(false);
      expect(restarted.events[0]?.includes(failureReason)).toBe(true);
    }
    const again = await open({ directory, currentVersion: runningVersion });
    expect(again.service.status().lastAttempt).toBeNull();
    expect(again.events).toEqual([]);
  });

  it('keeps the first line of why the installer could not take over for the next start', async () => {
    const { service, directory } = await ready();
    await service.apply({ version: offer.version });
    await service.close();
    await service.recordInstallFailure(new Error('Squirrel refused the update\n    at ShipIt (native)'));
    const restarted = await open({ directory });
    expect(restarted.service.status().lastAttempt).toMatchObject({ outcome: 'incomplete', detail: 'Squirrel refused the update' });
  });
});

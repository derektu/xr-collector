import { expect, it, vi } from 'vitest';
import type { UpdateOffer } from '../../src/core/types.js';
import { PinnedNsisUpdater, WindowsNativeInstaller, type WindowsUpdaterAdapter } from '../../src/updates/windows-installer.js';

const offer = {
  version: '0.1.2', commit: 'a'.repeat(40), target: 'win32-x64', releaseNotes: '',
  source: { id: 'test', indexUrl: 'https://example.test/latest.json' },
  payload: { name: 'XR-Collector.exe', url: 'https://example.test/XR-Collector.exe', bytes: 12, sha256: 'b'.repeat(64) },
  buildInfo: { version: '0.1.2', buildId: 'build-b', commit: 'a'.repeat(40), builtAt: new Date().toISOString(),
    target: 'win32-x64', sourceDirty: false },
} satisfies UpdateOffer;

function adapter(installPinned: WindowsUpdaterAdapter['installPinned'] = async () => undefined): WindowsUpdaterAdapter {
  return { accept: vi.fn(async () => undefined), installPinned: vi.fn(installPinned) };
}

it('accepts pinned bytes before handoff and propagates an installer launch failure before completion', async () => {
  const updater = adapter(async () => { throw new Error('spawn ENOENT'); });
  const installer = new WindowsNativeInstaller(true, { platform: 'win32', updater });
  const prepared = await installer.prepare(offer, 'C:\\cache\\XR-Collector.exe', new AbortController().signal);
  expect(updater.accept).toHaveBeenCalledWith(offer, 'C:\\cache\\XR-Collector.exe');
  await expect(prepared.handoff()).rejects.toThrow('spawn ENOENT');
  expect(updater.installPinned).toHaveBeenCalledTimes(1);
  await prepared.cancel();
});

it('does not expose the Windows installer on another platform or for an unpackaged app', async () => {
  const updater = adapter();
  const otherPlatform = new WindowsNativeInstaller(true, { platform: 'darwin', updater });
  const unpackaged = new WindowsNativeInstaller(false, { platform: 'win32', updater });
  expect(otherPlatform.available).toBe(false); expect(unpackaged.available).toBe(false);
  await expect(otherPlatform.prepare(offer, '/tmp/XR-Collector.exe', new AbortController().signal))
    .rejects.toMatchObject({ code: 'update_install_unavailable' });
  expect(updater.accept).not.toHaveBeenCalled();
});

it('turns electron-updater error events into an explicit handoff failure instead of an unhandled error', async () => {
  const app = { version: '0.1.1', name: 'XR Collector', isPackaged: true,
    appUpdateConfigPath: '/tmp/app-update.yml', userDataPath: '/tmp', baseCachePath: '/tmp',
    whenReady: async () => undefined, relaunch: vi.fn(), quit: vi.fn(), onQuit: vi.fn() };
  const updater = new PinnedNsisUpdater(app);
  vi.spyOn(updater, 'install').mockImplementation(() => { updater.emit('error', new Error('installer missing')); return true; });
  await expect(updater.installPinned()).rejects.toMatchObject({ code: 'update_apply_failed', message: expect.stringContaining('installer missing') });
});

it('consumes a post-handoff NSIS error without claiming the old App can observe the final install outcome', async () => {
  const updater = new PinnedNsisUpdater({ version: '0.1.1', name: 'XR Collector', isPackaged: true,
    appUpdateConfigPath: '/tmp/app-update.yml', userDataPath: '/tmp', baseCachePath: '/tmp',
    whenReady: async () => undefined, relaunch: vi.fn(), quit: vi.fn(), onQuit: vi.fn() });
  vi.spyOn(updater, 'install').mockImplementation(() => {
    setTimeout(() => updater.emit('error', new Error('NSIS failed after parent exit')), 20); return true;
  });
  await expect(updater.installPinned()).resolves.toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(updater.listenerCount('error')).toBeGreaterThan(0);
});

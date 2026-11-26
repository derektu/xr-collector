import { describe, expect, it } from 'vitest';
import { trayLabelText, trayModel } from '../../../src/desktop/electron/tray-menu.js';
import type { DeviceUpdateStatus, UpdatePhase } from '../../../src/shared/api/update-types.js';
import { sidebarUpdateLabel } from '../../../src/transport/web/settings/update-presentation.js';

const offer = { version: '0.1.3' };
function status(phase: UpdatePhase, options: Partial<DeviceUpdateStatus> = {}): DeviceUpdateStatus {
  return { phase, currentVersion: '0.1.2', target: 'darwin-arm64', installerAvailable: true, offer, ready: null, lastAttempt: null,
    progress: null, lastCheckAttemptAt: null, checkedAt: null, message: '', errorCode: null, detail: null, ...options };
}

function trayText(update: DeviceUpdateStatus): string {
  const item = trayModel({ update }, new Date()).items.find((entry) => entry.kind === 'action' && entry.action === 'check_app_update');
  if (item?.kind !== 'action' || typeof item.label === 'string') throw new Error('the tray menu has no App update entry');
  return trayLabelText(item.label);
}

describe('the sidebar and the tray menu name an update step with the same words, the tray prefixed with the App update entry', () => {
  it.each([
    ['available', status('available'), '有新版本'],
    ['downloading with a known size', status('downloading', { progress: { transferred: 62, total: 100, percent: 62 } }), '下載中 62%'],
    ['downloading before the size is known', status('downloading', { progress: { transferred: 0, total: 0, percent: 0 } }), '下載中'],
    ['ready', status('ready', { ready: offer }), '可安裝'],
    ['installing', status('installing', { ready: offer }), '安裝中'],
  ])('%s', (_case, update, words) => {
    expect(sidebarUpdateLabel(update)).toBe(words);
    expect(trayText(update).startsWith(`App 更新：${words}`)).toBe(true);
  });
});

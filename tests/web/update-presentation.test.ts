import { describe, expect, it } from 'vitest';
import type { DeviceUpdateStatus, UpdateOffer, UpdatePhase } from '../../src/core/types.js';
import { sidebarUpdateLabel } from '../../src/web/update-presentation.js';

const offer = { version: '0.1.3' } as UpdateOffer;
function status(phase: UpdatePhase, options: Partial<DeviceUpdateStatus> = {}): DeviceUpdateStatus {
  return { phase, currentVersion: '0.1.2', target: 'darwin-arm64', installerAvailable: true,
    offer: null, ready: null, lastAttempt: null, progress: null, lastCheckAttemptAt: null, checkedAt: null, message: '', errorCode: null, ...options };
}

describe('sidebarUpdateLabel', () => {
  it.each(['idle', 'checking', 'up_to_date', 'error'] as const)('keeps %s quiet', (phase) => {
    expect(sidebarUpdateLabel(status(phase, { offer }))).toBeNull();
  });

  it('announces a new version only with a discovered offer', () => {
    expect(sidebarUpdateLabel(status('available'))).toBeNull();
    expect(sidebarUpdateLabel(status('available', { offer }))).toBe('有新版本');
  });

  it.each([
    ['downloading', '下載中'], ['verifying', '驗證中'], ['ready', '可安裝'],
    ['waiting', '等待安裝'], ['installing', '安裝中'],
  ] as const)('describes the real %s action', (phase, label) => {
    expect(sidebarUpdateLabel(status(phase, { offer, ready: offer }))).toBe(label);
  });

  it('shows only the version when this environment cannot install', () => {
    expect(sidebarUpdateLabel(status('ready', { ready: offer, installerAvailable: false }))).toBeNull();
  });
});

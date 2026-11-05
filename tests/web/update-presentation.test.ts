// The update label in the sidebar: quiet while idle, checking, up to date or failed, a new version
// announced only with a discovered offer, the current step from downloading through installing,
// and nothing when this environment cannot install.
import { describe, expect, it } from 'vitest';
import type { DeviceUpdateStatus, UpdateOffer, UpdatePhase } from '../../src/core/types.js';
import { sidebarUpdate } from '../../src/web/update-presentation.js';

const offer = { version: '0.1.3' } as UpdateOffer;
function status(phase: UpdatePhase, options: Partial<DeviceUpdateStatus> = {}): DeviceUpdateStatus {
  return { phase, currentVersion: '0.1.2', target: 'darwin-arm64', installerAvailable: true,
    offer: null, ready: null, lastAttempt: null, progress: null, lastCheckAttemptAt: null, checkedAt: null, message: '', errorCode: null, ...options };
}

describe('sidebarUpdate', () => {
  it.each(['idle', 'checking', 'up_to_date', 'error'] as const)('keeps %s quiet', (phase) => {
    expect(sidebarUpdate(status(phase, { offer }))).toBeNull();
  });

  it('announces a new version only with a discovered offer', () => {
    expect(sidebarUpdate(status('available'))).toBeNull();
    expect(sidebarUpdate(status('available', { offer }))).toBe('available');
  });

  it.each(['downloading', 'verifying', 'ready', 'waiting', 'installing'] as const)('names the real %s step', (phase) => {
    expect(sidebarUpdate(status(phase, { offer, ready: offer }))).toBe(phase);
  });

  it.each(['ready', 'waiting', 'installing'] as const)('keeps %s quiet without a ready download', (phase) => {
    expect(sidebarUpdate(status(phase, { offer }))).toBeNull();
  });

  it('shows only the version when this environment cannot install', () => {
    expect(sidebarUpdate(status('ready', { ready: offer, installerAvailable: false }))).toBeNull();
  });
});

// The update label in the sidebar: quiet while idle, checking, up to date or failed, a new version
// announced only with a discovered offer, the current step from downloading through installing,
// and nothing when this environment cannot install.
import { describe, expect, it } from 'vitest';
import type { DeviceUpdateStatus, UpdateOffer, UpdatePhase } from '../../../src/shared/api/update-types.js';
import { sidebarUpdate, updateMessageTone } from '../../../src/transport/web/update-presentation.js';

const offer = { version: '0.1.3' } as UpdateOffer;
function status(phase: UpdatePhase, options: Partial<DeviceUpdateStatus> = {}): DeviceUpdateStatus {
  return { phase, currentVersion: '0.1.2', target: 'darwin-arm64', installerAvailable: true,
    offer: null, ready: null, lastAttempt: null, progress: null, lastCheckAttemptAt: null, checkedAt: null, message: '', errorCode: null, detail: null, ...options };
}

describe('sidebarUpdate', () => {
  it.each(['idle', 'checking', 'up_to_date', 'error'] as const)('keeps %s quiet', (phase) => {
    expect(sidebarUpdate(status(phase, { offer }))).toBeNull();
  });

  it('announces a new version only with a discovered offer', () => {
    expect(sidebarUpdate(status('available'))).toBeNull();
    expect(sidebarUpdate(status('available', { offer }))).toBe('available');
  });

  it.each(['downloading', 'ready', 'installing'] as const)('names the real %s step', (phase) => {
    expect(sidebarUpdate(status(phase, { offer, ready: offer }))).toBe(phase);
  });

  it.each(['ready', 'installing'] as const)('keeps %s quiet without a ready download', (phase) => {
    expect(sidebarUpdate(status(phase, { offer }))).toBeNull();
  });

  it('shows only the version when this environment cannot install', () => {
    expect(sidebarUpdate(status('ready', { ready: offer, installerAvailable: false }))).toBeNull();
  });
});

describe('updateMessageTone', () => {
  it.each([
    ['a failed check', 'problem', status('error', { errorCode: 'update_source_failed' })],
    ['a failed check that keeps a ready download', 'problem', status('ready', { ready: offer, errorCode: 'update_source_failed' })],
    ['a failed download', 'problem', status('error', { offer, errorCode: 'update_download_failed' })],
    ['a new version', 'offer', status('available', { offer })],
    ['a ready download', 'offer', status('ready', { offer, ready: offer })],
    ['an up-to-date check', 'plain', status('up_to_date')],
    ['a download in progress', 'plain', status('downloading', { offer })],
  ] as const)('shows %s as %s', (_name, tone, given) => {
    expect(updateMessageTone(given)).toBe(tone);
  });
});

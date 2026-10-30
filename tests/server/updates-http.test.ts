import { describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../src/server/app.js';
import type { DeviceUpdateStatus } from '../../src/core/types.js';

const hash = 'a'.repeat(64);
const status: DeviceUpdateStatus = {
  phase: 'available', checkedAt: '2026-10-26T00:00:00.000Z',
  currentVersion: '0.1.0', target: 'darwin-arm64', installerAvailable: true, lastAttempt: null,
  offer: null, ready: null, progress: null, message: '有新版本。', errorCode: null,
};

describe('device update HTTP API', () => {
  it('is available without a Vault and binds mutations to the selected offer', async () => {
    const updates = {
      status: vi.fn(() => status), check: vi.fn(async () => status),
      download: vi.fn(async () => status), apply: vi.fn(async () => status), cancel: vi.fn(async () => status),
    };
    const app = await createHttpApp({ updates, notReady: () => 'Vault 尚未設定。' });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/device/updates' })).statusCode).toBe(200);
      const response = await app.inject({ method: 'POST', url: '/api/device/updates/download', payload: { version: '0.1.1', sha256: hash } });
      expect(response.statusCode).toBe(200);
      expect(updates.download).toHaveBeenCalledWith({ version: '0.1.1', sha256: hash });
      expect((await app.inject({ method: 'POST', url: '/api/device/updates/apply', payload: { version: '0.1.1', sha256: hash, extra: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/device/updates/check' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/device/updates/cancel' })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

// The device update API (/api/device/updates) works without a Vault, hands each request to the update
// service, and names the chosen version and nothing else, so the UI or an Agent acts on the update it chose.
import { describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../src/transport/server/app.js';
import type { DeviceUpdateStatus } from '../../../../src/shared/api/update-types.js';
import { CollectorError } from '../../../../src/shared/lib/collector-error.js';
import { PRODUCT_SOURCES } from '../../../support/product-sources.js';

const status: DeviceUpdateStatus = {
  phase: 'available', checkedAt: '2026-10-26T00:00:00.000Z', lastCheckAttemptAt: '2026-10-26T00:00:00.000Z',
  currentVersion: '0.1.0', target: 'darwin-arm64', installerAvailable: true, lastAttempt: null,
  offer: null, ready: null, progress: null, message: '有新版本。', errorCode: null, detail: null,
};

async function app() {
  const updates = {
    status: vi.fn(() => status), check: vi.fn(async () => status), cancel: vi.fn(async () => status),
    download: vi.fn(async () => status),
    apply: vi.fn(async () => { throw new CollectorError('update_not_ready', '請先下載更新。'); }),
  };
  return { updates, server: await createHttpApp({ sources: PRODUCT_SOURCES, updates, notReady: () => 'Vault 尚未設定。' }) };
}

describe('device update HTTP API without a Vault', () => {
  it.each([
    ['GET', '/api/device/updates', undefined, 'status', 200],
    ['POST', '/api/device/updates/check', undefined, 'check', 200],
    ['POST', '/api/device/updates/download', { version: '0.1.1' }, 'download', 200],
    ['POST', '/api/device/updates/apply', { version: '0.1.1' }, 'apply', 409],
    ['POST', '/api/device/updates/cancel', undefined, 'cancel', 200],
  ] as const)('%s %s reaches the update service', async (method, url, payload, call, statusCode) => {
    const { updates, server } = await app();
    try {
      expect((await server.inject({ method, url, ...(payload ? { payload } : {}) })).statusCode).toBe(statusCode);
      expect(updates[call]).toHaveBeenCalledOnce();
      if (payload) expect(updates[call]).toHaveBeenCalledWith(payload);
    } finally { await server.close(); }
  });

  it('refuses a selection with anything besides the version', async () => {
    const { updates, server } = await app();
    try {
      const response = await server.inject({ method: 'POST', url: '/api/device/updates/download', payload: { version: '0.1.1', sha256: 'a'.repeat(64) } });
      expect(response.statusCode).toBe(400);
      expect(updates.download).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});

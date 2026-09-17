import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonChannelScheduleStore } from '../src/channels/json-channel-schedule-store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('JsonChannelScheduleStore', () => {
  it('persists schedule settings and progress across instances', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-schedule-'));
    temporaryRoots.push(root);
    const first = new JsonChannelScheduleStore(root);

    expect(await first.load()).toEqual({
      enabled: false,
      intervalMinutes: 60,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
      lastResult: null,
    });

    await first.save({
      enabled: true,
      intervalMinutes: 15,
      lastAttemptAt: '2026-09-17T00:00:00.000Z',
      lastCompletedAt: '2026-09-17T00:01:00.000Z',
      nextRunAt: '2026-09-17T00:16:00.000Z',
      lastResult: {
        runId: 'run-1',
        created: 2,
        existing: 3,
        failed: 1,
      },
    });

    expect(await new JsonChannelScheduleStore(root).load()).toEqual({
      enabled: true,
      intervalMinutes: 15,
      lastAttemptAt: '2026-09-17T00:00:00.000Z',
      lastCompletedAt: '2026-09-17T00:01:00.000Z',
      nextRunAt: '2026-09-17T00:16:00.000Z',
      lastResult: {
        runId: 'run-1',
        created: 2,
        existing: 3,
        failed: 1,
      },
    });
  });
});

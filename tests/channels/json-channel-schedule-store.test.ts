import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('JsonChannelScheduleStore', () => {
  it('persists schedule settings and progress across instances', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-schedule-'));
    temporaryRoots.push(root);
    const first = new JsonChannelScheduleStore(root);

    // A Vault without a schedule file collects automatically with the default policy.
    expect(await first.load()).toEqual({
      enabled: true,
      intervalMinutes: 30,
      backfillWindow: '1m',
      backfillMaxItems: 10,
      lastAttemptAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
      lastResult: null,
    });

    await first.save({
      enabled: true,
      intervalMinutes: 15,
      backfillWindow: '3m',
      backfillMaxItems: 50,
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
      backfillWindow: '3m',
      backfillMaxItems: 50,
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

  it.each([
    [45, 60],
    [20_000, 1440],
    [1, 15],
    [60, 60],
  ])('loads a first-round file with interval %i as %i, its on/off value and the default backfill', async (stored, loaded) => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-schedule-legacy-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'settings'));
    await writeFile(path.join(root, 'settings', 'youtube-schedule.json'), JSON.stringify({
      version: 1, enabled: false, intervalMinutes: stored,
      lastAttemptAt: null, lastCompletedAt: null, nextRunAt: null, lastResult: null,
    }));
    expect(await new JsonChannelScheduleStore(root).load()).toMatchObject({
      enabled: false, intervalMinutes: loaded, backfillWindow: '1m', backfillMaxItems: 10,
    });
  });
});

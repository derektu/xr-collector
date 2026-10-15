import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { migrateSubscriptionSettings } from '../../src/channels/subscription-files.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function vault(files: { channels?: unknown; schedule?: unknown }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-subscription-files-'));
  roots.push(root);
  await mkdir(path.join(root, 'settings'));
  if (files.channels !== undefined) await writeFile(path.join(root, 'settings', 'youtube-channels.json'), JSON.stringify(files.channels));
  if (files.schedule !== undefined) await writeFile(path.join(root, 'settings', 'youtube-schedule.json'), JSON.stringify(files.schedule));
  return root;
}

const read = async (root: string, name: string) => JSON.parse(await readFile(path.join(root, 'settings', name), 'utf8')) as unknown;

function row(id: string, enabled = true) {
  return {
    id, title: `頻道 ${id}`, url: `https://www.youtube.com/channel/${id}/videos`, enabled, addedAt: '2026-09-01T00:00:00.000Z',
    cursor: null, lastCheckedAt: '2026-10-15T03:30:00.000Z', backlog: false,
  };
}

/** A Vault as the shared-settings version wrote it: three subscriptions and one schedule file. */
const sharedSchedule = {
  version: 1, enabled: true, intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 20,
  lastAttemptAt: '2026-10-15T03:30:00.000Z', lastCompletedAt: '2026-10-15T03:31:00.000Z', nextRunAt: '2026-10-15T04:30:00.000Z',
  lastResult: { runId: null, created: 1, existing: 0, failed: 0 },
};

describe('subscription settings conversion (A1)', () => {
  it('copies the shared settings and check times to every subscription once', async () => {
    const root = await vault({ channels: [row('UCa'), row('UCb'), row('UCc', false)], schedule: sharedSchedule });
    expect(await migrateSubscriptionSettings(root)).toBe(true);
    const settings = { intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 20 };
    expect(await read(root, 'youtube-channels.json')).toEqual({
      version: 2,
      channels: [
        { ...row('UCa'), settings, nextCheckAt: '2026-10-15T04:30:00.000Z', lastDispatchedAt: '2026-10-15T03:30:00.000Z' },
        { ...row('UCb'), settings, nextCheckAt: '2026-10-15T04:30:00.000Z', lastDispatchedAt: '2026-10-15T03:30:00.000Z' },
        { ...row('UCc', false), settings, nextCheckAt: null, lastDispatchedAt: '2026-10-15T03:30:00.000Z' },
      ],
    });
    expect(await read(root, 'youtube-schedule.json')).toEqual({ version: 2, enabled: true, legacySettings: { intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 20 } });

    const channels = await readFile(path.join(root, 'settings', 'youtube-channels.json'));
    const schedule = await readFile(path.join(root, 'settings', 'youtube-schedule.json'));
    for (let again = 0; again < 2; again += 1) {
      expect(await migrateSubscriptionSettings(root)).toBe(false);
      expect(await readFile(path.join(root, 'settings', 'youtube-channels.json'))).toEqual(channels);
      expect(await readFile(path.join(root, 'settings', 'youtube-schedule.json'))).toEqual(schedule);
    }
  });

  it('never converts again after stopping between the two writes, and ignores the shared settings left behind', async () => {
    const root = await vault({ channels: [row('UCa')], schedule: sharedSchedule });
    await migrateSubscriptionSettings(root);
    // The stop left the version 1 schedule file, now with different shared settings.
    await writeFile(path.join(root, 'settings', 'youtube-schedule.json'), JSON.stringify({ ...sharedSchedule, enabled: false, intervalMinutes: 15, backfillMaxItems: 5 }));
    expect(await new JsonChannelScheduleStore(root).load()).toEqual({ enabled: false });
    expect(await migrateSubscriptionSettings(root)).toBe(true);
    // The leftover file still names the shared settings; they only serve jobs accepted before the conversion.
    expect(await read(root, 'youtube-schedule.json')).toEqual({ version: 2, enabled: false, legacySettings: { intervalMinutes: 15, backfillWindow: '2w', backfillMaxItems: 5 } });
    expect((await new JsonChannelStore(root).list())[0]!.settings).toEqual({ intervalMinutes: 60, backfillWindow: '2w', backfillMaxItems: 20 });
  });

  it.each([
    [45, 60],
    [20_000, 1440],
    [7, 15],
  ])('gives subscriptions of a file without backfill settings interval %i as %i and the default backfill', async (stored, interval) => {
    const root = await vault({
      channels: [row('UCa')],
      schedule: { version: 1, enabled: false, intervalMinutes: stored, lastAttemptAt: null, lastCompletedAt: null, nextRunAt: null, lastResult: null },
    });
    await migrateSubscriptionSettings(root);
    expect((await new JsonChannelStore(root).list())[0]).toMatchObject({
      settings: { intervalMinutes: interval, backfillWindow: '1m', backfillMaxItems: 10 }, nextCheckAt: null, lastDispatchedAt: null,
    });
    expect(await new JsonChannelScheduleStore(root).load()).toEqual({ enabled: false });
  });

  it('gives subscriptions of a Vault without a schedule file the defaults', async () => {
    const root = await vault({ channels: [row('UCa')] });
    await migrateSubscriptionSettings(root);
    expect((await new JsonChannelStore(root).list())[0]!.settings).toEqual({ intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 });
    expect(await new JsonChannelScheduleStore(root).load()).toEqual({ enabled: true });
  });

  it('rejects files it cannot read instead of guessing', async () => {
    for (const channels of [{}, { version: 3, channels: [] }, { version: 2, channels: [{ ...row('UCa'), settings: { intervalMinutes: 45, backfillWindow: '1m', backfillMaxItems: 10 } }] }]) {
      const root = await vault({ channels });
      await expect(new JsonChannelStore(root).list()).rejects.toThrow('Invalid YouTube channel settings');
    }
    const root = await vault({ schedule: { version: 2 } });
    await expect(new JsonChannelScheduleStore(root).load()).rejects.toThrow('Invalid YouTube channel schedule settings');
  });
});

describe('JsonChannelStore', () => {
  it('persists subscriptions with their settings as version 2 across instances', async () => {
    const root = await vault({});
    const first = new JsonChannelStore(root);
    const settings = { intervalMinutes: 15, backfillWindow: '1w' as const, backfillMaxItems: 5 };
    await first.add({ ...row('UCa'), settings });
    await first.add({ ...row('UCb'), settings });
    await first.setEnabled('UCa', false);
    expect(await first.updateMany(new Map([['UCa', { nextCheckAt: null }], ['UCmissing', { nextCheckAt: null }]]))).toHaveLength(1);

    const restarted = new JsonChannelStore(root);
    expect(await restarted.list()).toEqual([
      expect.objectContaining({ id: 'UCa', enabled: false, settings, nextCheckAt: null }),
      expect.objectContaining({ id: 'UCb', enabled: true, settings }),
    ]);
    expect(await read(root, 'youtube-channels.json')).toMatchObject({ version: 2 });
    await restarted.remove('UCa');
    expect((await new JsonChannelStore(root).list()).map((channel) => channel.id)).toEqual(['UCb']);
  });

  it('saves the automatic collection switch as version 2; a Vault without the file collects automatically', async () => {
    const root = await vault({});
    const store = new JsonChannelScheduleStore(root);
    expect(await store.load()).toEqual({ enabled: true });
    await store.save({ enabled: false });
    expect(await new JsonChannelScheduleStore(root).load()).toEqual({ enabled: false });
    expect(await read(root, 'youtube-schedule.json')).toEqual({ version: 2, enabled: false });
  });
});

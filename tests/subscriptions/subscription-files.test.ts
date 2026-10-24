import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonScheduleStore } from '../../src/subscriptions/schedule-store.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';

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
    lastCheckedAt: '2026-10-15T03:30:00.000Z',
  };
}

/** A subscription row as it was stored while discovery kept a cursor. */
function rowWithCursor(id: string, enabled = true) {
  return { ...row(id, enabled), cursor: { videoId: 'cursor00001', publishedAt: null, recentIds: ['cursor00001'] }, backlog: false };
}

describe('subscription file versions', () => {
  it('reads no file of another version, leaves it untouched and does not convert it', async () => {
    const shared = { version: 1, enabled: true, intervalMinutes: 60, lastAttemptAt: null, nextRunAt: null };
    const root = await vault({ channels: [row('UCa')], schedule: shared });
    const before = await readFile(path.join(root, 'settings', 'youtube-channels.json'));
    await expect(new JsonSubscriptionStore(root, 'youtube').list()).rejects.toThrow('Invalid YouTube channel settings');
    await expect(new JsonScheduleStore(root).load()).rejects.toThrow('Invalid YouTube channel schedule settings');
    expect(await readFile(path.join(root, 'settings', 'youtube-channels.json'))).toEqual(before);
    expect(await read(root, 'youtube-schedule.json')).toEqual(shared);
  });

  it('rejects files it cannot read instead of guessing', async () => {
    const valid = { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 };
    for (const channels of [
      {}, { version: 2, channels: [] }, { version: 4, channels: [] },
      { version: 3, channels: [{ ...row('UCa'), settings: { ...valid, intervalMinutes: 45 } }] },
      { version: 3, channels: [{ ...row('UCa'), settings: valid }, { ...row('UCb'), settings: { ...valid, backfillDays: 61 } }] },
      { version: 3, channels: [{ ...row('UCa'), settings: { intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 } }] },
      { version: 3, channels: [{ ...row('UCa'), settings: valid, checkFailures: { count: 0, since: '2026-10-15T03:30:00.000Z', error: { code: 'x', message: 'x' } } }] },
      { version: 3, channels: [{ ...row('UCa'), settings: valid, checkFailures: { count: 2, since: '2026-10-15T03:30:00.000Z' } }] },
      { version: 3, channels: [{ ...row('UCa'), settings: valid, autoPausedAt: 1 }] },
    ]) {
      const root = await vault({ channels });
      await expect(new JsonSubscriptionStore(root, 'youtube').list()).rejects.toThrow('Invalid YouTube channel settings');
    }
    const root = await vault({ schedule: { version: 2 } });
    await expect(new JsonScheduleStore(root).load()).rejects.toThrow('Invalid YouTube channel schedule settings');
  });
});

describe('JsonSubscriptionStore', () => {
  it('persists subscriptions with their settings as version 3 across instances', async () => {
    const root = await vault({});
    const first = new JsonSubscriptionStore(root, 'youtube');
    const settings = { intervalMinutes: 15, backfillDays: 7, backfillMaxItems: 5 };
    await first.add({ ...row('UCa'), settings });
    await first.add({ ...row('UCb'), settings });
    await first.setEnabled('UCa', false);
    expect(await first.updateMany(new Map([['UCa', { nextCheckAt: null }], ['UCmissing', { nextCheckAt: null }]]))).toHaveLength(1);

    const restarted = new JsonSubscriptionStore(root, 'youtube');
    expect(await restarted.list()).toEqual([
      expect.objectContaining({ id: 'UCa', enabled: false, settings, nextCheckAt: null }),
      expect.objectContaining({ id: 'UCb', enabled: true, settings }),
    ]);
    expect(await read(root, 'youtube-channels.json')).toMatchObject({ version: 3 });
    await restarted.remove('UCa');
    expect((await new JsonSubscriptionStore(root, 'youtube').list()).map((channel) => channel.id)).toEqual(['UCb']);
  });

  it('keeps fields a subscription no longer uses, such as a discovery cursor, through reads and saves (R-10)', async () => {
    const settings = { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 };
    const root = await vault({ channels: { version: 3, channels: [{ ...rowWithCursor('UCa'), settings }, { ...row('UCb'), settings }] } });
    const store = new JsonSubscriptionStore(root, 'youtube');
    expect(await store.list()).toEqual([{ ...rowWithCursor('UCa'), settings }, { ...row('UCb'), settings }]);
    await store.update('UCa', { enabled: false });
    const saved = await read(root, 'youtube-channels.json') as { channels: Array<Record<string, unknown>> };
    expect(saved.channels[0]).toMatchObject({ enabled: false, cursor: rowWithCursor('UCa').cursor, backlog: false });
  });

  it('reads and writes failed items with a subscription, as collection progress that is not a change of it (N69-T1)', async () => {
    const settings = { intervalMinutes: 30, backfillDays: 30, backfillMaxItems: 10 };
    const failure = { videoId: 'aaaaaaaaaaa', title: '影片', attempts: 2, errorCode: 'no_subtitles', failedAt: '2026-10-15T03:30:00.000Z', skipped: false };
    // A file written before failures were recorded reads as a subscription without failures.
    const root = await vault({ channels: { version: 3, channels: [{ ...row('UCa'), settings, updatedAt: '2026-09-01T00:00:00.000Z' }] } });
    const store = new JsonSubscriptionStore(root, 'youtube', () => new Date('2026-10-16T00:00:00.000Z'));
    expect((await store.list())[0]!.failures).toBeUndefined();
    await store.update('UCa', { failures: [failure] });
    const saved = await read(root, 'youtube-channels.json') as { version: number; channels: Array<Record<string, unknown>> };
    expect(saved.version).toBe(3);
    expect(saved.channels[0]).toMatchObject({ failures: [failure], updatedAt: '2026-09-01T00:00:00.000Z' });
    expect((await new JsonSubscriptionStore(root, 'youtube').list())[0]!.failures).toEqual([failure]);
    await store.update('UCa', { failures: undefined });
    expect((await read(root, 'youtube-channels.json') as { channels: Array<Record<string, unknown>> }).channels[0]).not.toHaveProperty('failures');

    for (const broken of [{ ...failure, attempts: 0 }, { ...failure, skipped: 'no' }, { title: '影片', attempts: 1, errorCode: 'x', failedAt: 'y', skipped: false }]) {
      const invalid = await vault({ channels: { version: 3, channels: [{ ...row('UCa'), settings, failures: [broken] }] } });
      await expect(new JsonSubscriptionStore(invalid, 'youtube').list()).rejects.toThrow('Invalid YouTube channel settings');
    }
  });

  it('keeps other fields of the schedule file when saving the switch', async () => {
    const root = await vault({ schedule: { version: 2, enabled: true, note: 'kept' } });
    await new JsonScheduleStore(root).save({ enabled: false });
    expect(await read(root, 'youtube-schedule.json')).toEqual({ version: 2, enabled: false, note: 'kept' });
  });

  it('saves the automatic collection switch as version 2; a Vault without the file collects automatically', async () => {
    const root = await vault({});
    const store = new JsonScheduleStore(root);
    expect(await store.load()).toEqual({ enabled: true });
    await store.save({ enabled: false });
    expect(await new JsonScheduleStore(root).load()).toEqual({ enabled: false });
    expect(await read(root, 'youtube-schedule.json')).toEqual({ version: 2, enabled: false });
  });
});

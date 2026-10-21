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
    for (const channels of [{}, { version: 3, channels: [] }, { version: 2, channels: [{ ...row('UCa'), settings: { intervalMinutes: 45, backfillWindow: '1m', backfillMaxItems: 10 } }] }]) {
      const root = await vault({ channels });
      await expect(new JsonSubscriptionStore(root, 'youtube').list()).rejects.toThrow('Invalid YouTube channel settings');
    }
    const root = await vault({ schedule: { version: 2 } });
    await expect(new JsonScheduleStore(root).load()).rejects.toThrow('Invalid YouTube channel schedule settings');
  });
});

describe('JsonSubscriptionStore', () => {
  it('persists subscriptions with their settings as version 2 across instances', async () => {
    const root = await vault({});
    const first = new JsonSubscriptionStore(root, 'youtube');
    const settings = { intervalMinutes: 15, backfillWindow: '1w' as const, backfillMaxItems: 5 };
    await first.add({ ...row('UCa'), settings });
    await first.add({ ...row('UCb'), settings });
    await first.setEnabled('UCa', false);
    expect(await first.updateMany(new Map([['UCa', { nextCheckAt: null }], ['UCmissing', { nextCheckAt: null }]]))).toHaveLength(1);

    const restarted = new JsonSubscriptionStore(root, 'youtube');
    expect(await restarted.list()).toEqual([
      expect.objectContaining({ id: 'UCa', enabled: false, settings, nextCheckAt: null }),
      expect.objectContaining({ id: 'UCb', enabled: true, settings }),
    ]);
    expect(await read(root, 'youtube-channels.json')).toMatchObject({ version: 2 });
    await restarted.remove('UCa');
    expect((await new JsonSubscriptionStore(root, 'youtube').list()).map((channel) => channel.id)).toEqual(['UCb']);
  });

  it('keeps fields a subscription no longer uses, such as a discovery cursor, through reads and saves (R-10)', async () => {
    const settings = { intervalMinutes: 30, backfillWindow: '1m' as const, backfillMaxItems: 10 };
    const root = await vault({ channels: { version: 2, channels: [{ ...rowWithCursor('UCa'), settings }, { ...row('UCb'), settings }] } });
    const store = new JsonSubscriptionStore(root, 'youtube');
    expect(await store.list()).toEqual([{ ...rowWithCursor('UCa'), settings }, { ...row('UCb'), settings }]);
    await store.update('UCa', { enabled: false });
    const saved = await read(root, 'youtube-channels.json') as { channels: Array<Record<string, unknown>> };
    expect(saved.channels[0]).toMatchObject({ enabled: false, cursor: rowWithCursor('UCa').cursor, backlog: false });
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

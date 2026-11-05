// The field table of a subscription decides which changes stamp `updatedAt`, which count as a change
// in an import, and what an import takes from each machine. A field in the wrong part either lets
// an import overwrite a person's newer change, or lets another machine's progress overwrite this
// machine's.
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubscriptionRecord } from '../../src/core/types.js';
import { importedSubscription, subscriptionContent, SUBSCRIPTION_FIELDS } from '../../src/subscriptions/subscription-fields.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';

const checkFailures = { count: 2, since: '2026-10-17T00:00:00.000Z', error: { code: 'network_error', message: '無法連線。' } };

/** A subscription with every field set. */
const record: Required<SubscriptionRecord> = {
  id: 'UCa', title: '頻道 A', url: 'https://www.youtube.com/channel/UCa', enabled: true, addedAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z', settings: { intervalMinutes: 60, backfillDays: 30, backfillMaxItems: 10 },
  nextCheckAt: '2026-10-20T00:00:00.000Z', lastDispatchedAt: '2026-10-19T00:00:00.000Z', lastCheckedAt: '2026-10-19T00:10:00.000Z',
  checkFailures, autoPausedAt: '2026-10-18T00:00:00.000Z',
  outOfRange: [{ videoId: 'aaaaaaaaaa1', before: '2026-09-01T00:00:00.000Z' }],
  failures: [{ videoId: 'aaaaaaaaaa2', title: '影片', attempts: 1, errorCode: 'network_error', failedAt: '2026-10-19T00:00:00.000Z', skipped: false }],
};

/** Another valid value of every field, as the other machine might hold it. */
const other: Required<SubscriptionRecord> = {
  id: 'UCa', title: '頻道 A（改名）', url: 'https://www.youtube.com/channel/UCa/videos', enabled: false, addedAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z', settings: { intervalMinutes: 360, backfillDays: 7, backfillMaxItems: 5 },
  nextCheckAt: '2026-10-25T00:00:00.000Z', lastDispatchedAt: '2026-10-24T00:00:00.000Z', lastCheckedAt: '2026-10-24T00:10:00.000Z',
  checkFailures: { ...checkFailures, count: 4 }, autoPausedAt: '2026-10-24T00:20:00.000Z',
  outOfRange: [{ videoId: 'bbbbbbbbbb1', before: '2026-10-01T00:00:00.000Z' }],
  failures: [{ videoId: 'bbbbbbbbbb2', title: '另一支', attempts: 2, errorCode: 'capture_failed', failedAt: '2026-10-24T00:00:00.000Z', skipped: false }],
};

const fields = Object.keys(SUBSCRIPTION_FIELDS) as Array<keyof SubscriptionRecord>;
const partOf = (part: string) => fields.filter((field) => SUBSCRIPTION_FIELDS[field] === part);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('the field table', () => {
  it('classes every field of a record', () => {
    expect(fields.sort()).toEqual(Object.keys(record).sort());
    expect(partOf('person').sort()).toEqual(['enabled', 'settings', 'title', 'updatedAt', 'url']);
  });

  it('counts a change of a person field other than updatedAt as a change of content, and no other', () => {
    const changed = fields.filter((field) => subscriptionContent({ ...record, [field]: other[field] }) !== subscriptionContent(record));
    expect(changed.sort()).toEqual(['enabled', 'settings', 'title', 'url']);
  });

  it('stamps updatedAt for a change of a person field, and for no other', async () => {
    const stamped: string[] = [];
    for (const field of fields.filter((candidate) => !['id', 'addedAt', 'updatedAt'].includes(candidate))) {
      const root = await mkdtemp(path.join(tmpdir(), 'xr-subscription-fields-'));
      roots.push(root);
      const store = new JsonSubscriptionStore(root, 'youtube', () => new Date('2030-01-01T00:00:00.000Z'));
      await store.add(record);
      await store.update(record.id, { [field]: other[field] });
      const file = JSON.parse(await readFile(path.join(root, 'settings/youtube-channels.json'), 'utf8')) as { channels: SubscriptionRecord[] };
      expect(file.channels[0]![field]).toEqual(other[field]);
      if (file.channels[0]!.updatedAt !== record.updatedAt) stamped.push(field);
    }
    expect(stamped.sort()).toEqual(['enabled', 'settings', 'title', 'url']);
  });
});

describe('an imported subscription', () => {
  it('takes the person fields from the other machine, keeps the local identity and progress, and starts the schedule over', () => {
    const local = { ...record, enabled: false };
    expect(importedSubscription(local, { ...other, enabled: false })).toEqual({
      id: 'UCa', addedAt: local.addedAt,
      title: other.title, url: other.url, enabled: false, settings: other.settings, updatedAt: other.updatedAt,
      lastCheckedAt: local.lastCheckedAt, checkFailures: local.checkFailures, outOfRange: local.outOfRange, failures: local.failures,
      nextCheckAt: null, lastDispatchedAt: null, autoPausedAt: other.autoPausedAt,
    });
  });

  it('keeps the local lastCheckedAt, also when the local record has none', () => {
    expect(importedSubscription(record, other).lastCheckedAt).toBe(record.lastCheckedAt);
    const { lastCheckedAt: _lastCheckedAt, checkFailures: _checkFailures, ...withoutProgress } = record;
    const imported = importedSubscription(withoutProgress, other);
    expect('lastCheckedAt' in imported).toBe(false);
    expect('checkFailures' in imported).toBe(false);
  });

  it('keeps an automatic pause only while paused with the failures that caused it', () => {
    expect(importedSubscription(record, { ...other, enabled: true })).not.toHaveProperty('autoPausedAt');
    const { checkFailures: _checkFailures, ...noFailures } = record;
    expect(importedSubscription(noFailures, other)).not.toHaveProperty('autoPausedAt');
    expect(importedSubscription(record, other).autoPausedAt).toBe(other.autoPausedAt);
  });

  it('arrives whole with a fresh schedule when the Vault does not have it, keeping fields the program does not define', () => {
    const incoming = { ...other, cursor: 'kept' } as SubscriptionRecord;
    expect(importedSubscription(undefined, incoming)).toEqual({ ...other, cursor: 'kept', nextCheckAt: null, lastDispatchedAt: null });
  });
});

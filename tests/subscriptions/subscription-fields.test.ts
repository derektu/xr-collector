// The field table of a subscription decides which changes stamp `updatedAt`, which count as a change
// in an import, and what an import takes from each machine. A field in the wrong part either lets
// an import overwrite a person's newer change, or lets another machine's progress overwrite this
// machine's.
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubscriptionRecord } from '../../src/core/subscription-types.js';
import { importedSubscription, subscriptionContent, SUBSCRIPTION_FIELDS } from '../../src/subscriptions/subscription-fields.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { VaultFileWriter } from '../../src/vault/vault-files.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

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

/** `record` without a pause it made itself, so that turning `enabled` off is a pause by the person. */
const { autoPausedAt: _recordPause, ...base } = record;
/** `other` paused by the person rather than by itself. */
const { autoPausedAt: _otherPause, ...otherByPerson } = other;
/** `record` after it paused itself. */
const pausedItself = { ...record, enabled: false };

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
    const changed = fields.filter((field) => subscriptionContent({ ...base, [field]: other[field] }) !== subscriptionContent(base));
    expect(changed.sort()).toEqual(['enabled', 'settings', 'title', 'url']);
  });

  it('counts a pause the subscription made itself, and the end of it, as no change of content', () => {
    expect(subscriptionContent(pausedItself)).toBe(subscriptionContent(base));
    expect(subscriptionContent({ ...base, enabled: false })).not.toBe(subscriptionContent(base));
  });

  /** The stored record after `changes` are applied one after another to `start`. */
  async function stored(start: SubscriptionRecord, ...changes: Array<Partial<SubscriptionRecord>>): Promise<SubscriptionRecord> {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-subscription-fields-'));
    roots.push(root);
    const store = new JsonSubscriptionStore(new VaultFileWriter(root, PRODUCT_SOURCES), 'youtube', () => new Date('2030-01-01T00:00:00.000Z'));
    await store.add(start);
    for (const change of changes) await store.update(start.id, change);
    const file = JSON.parse(await readFile(path.join(root, 'settings/youtube-channels.json'), 'utf8')) as { channels: SubscriptionRecord[] };
    return file.channels[0]!;
  }

  it('stamps updatedAt for a change of a person field, and for no other', async () => {
    const stamped: string[] = [];
    for (const field of fields.filter((candidate) => !['id', 'addedAt', 'updatedAt'].includes(candidate))) {
      const row = await stored(base, { [field]: other[field] });
      expect(row[field]).toEqual(other[field]);
      if (row.updatedAt !== base.updatedAt) stamped.push(field);
    }
    expect(stamped.sort()).toEqual(['enabled', 'settings', 'title', 'url']);
  });

  it('stamps no updatedAt when the subscription pauses itself or is resumed from that pause', async () => {
    const pause = { enabled: false, nextCheckAt: null, autoPausedAt: other.autoPausedAt };
    expect((await stored(base, pause)).updatedAt).toBe(base.updatedAt);
    expect((await stored(base, pause, { enabled: true, autoPausedAt: undefined })).updatedAt).toBe(base.updatedAt);
  });
});

describe('an imported subscription', () => {
  it('takes the person fields from the other machine, keeps the local identity and progress, and starts the schedule over', () => {
    expect(importedSubscription(base, otherByPerson)).toEqual({
      id: 'UCa', addedAt: base.addedAt,
      title: other.title, url: other.url, enabled: false, settings: other.settings, updatedAt: other.updatedAt,
      lastCheckedAt: base.lastCheckedAt, checkFailures: base.checkFailures, outOfRange: base.outOfRange, failures: base.failures,
      nextCheckAt: null, lastDispatchedAt: null,
    });
  });

  it('keeps the local lastCheckedAt, also when the local record has none', () => {
    expect(importedSubscription(record, other).lastCheckedAt).toBe(record.lastCheckedAt);
    const { lastCheckedAt: _lastCheckedAt, checkFailures: _checkFailures, ...withoutProgress } = record;
    const imported = importedSubscription(withoutProgress, other);
    expect('lastCheckedAt' in imported).toBe(false);
    expect('checkFailures' in imported).toBe(false);
  });

  it('leaves the local subscription on when it paused itself only on the other machine', () => {
    const imported = importedSubscription(base, other);
    expect(imported).toMatchObject({ enabled: true, settings: other.settings, checkFailures: base.checkFailures });
    expect(imported).not.toHaveProperty('autoPausedAt');
  });

  it('keeps a pause the local subscription made itself while the person setting leaves it on, on either machine', () => {
    for (const incoming of [{ ...otherByPerson, enabled: true }, other]) {
      expect(importedSubscription(pausedItself, incoming)).toMatchObject({
        enabled: false, autoPausedAt: record.autoPausedAt, checkFailures: record.checkFailures, settings: other.settings,
      });
    }
  });

  it('replaces a pause the local subscription made itself with a pause by the person', () => {
    const imported = importedSubscription(pausedItself, otherByPerson);
    expect(imported.enabled).toBe(false);
    expect(imported).not.toHaveProperty('autoPausedAt');
  });

  it('arrives whole with a fresh schedule when the Vault does not have it, keeping fields the program does not define', () => {
    const incoming = { ...otherByPerson, cursor: 'kept' } as SubscriptionRecord;
    expect(importedSubscription(undefined, incoming)).toEqual({ ...otherByPerson, cursor: 'kept', nextCheckAt: null, lastDispatchedAt: null });
  });

  it('arrives on, without the failures that paused it, when it paused itself on the other machine', () => {
    const { checkFailures: _checkFailures, ...rest } = otherByPerson;
    expect(importedSubscription(undefined, other)).toEqual({ ...rest, enabled: true, nextCheckAt: null, lastDispatchedAt: null });
  });
});

import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog, RETENTION_DAYS } from '../../src/activity/activity-log.js';
import { ActivityViews } from '../../src/activity/activity-views.js';
import { limitText, protectSecret, redact } from '../../src/core/redact.js';
import type { CollectionJob, JobEvent } from '../../src/core/types.js';
import { localDayStart } from '../../src/web/activity-presentation.js';
import { readEventFiles } from './event-files.js';
import { eventually } from '../support/wait.js';

// The device activity log: day files written once a second with a 30-day retention, newest-first
// cursor pages, filters, masking and write failures that are reported, not lost.

const DAY = 86_400_000;
const VAULT = '/vaults/a';
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(path.join(directory, 'events'), 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xr-activity-'));
  directories.push(directory);
  return directory;
}

class Clock {
  constructor(public now: Date) {}
  advance(ms: number): void { this.now = new Date(this.now.getTime() + ms); }
}

/** Timers that run only when the test fires them. */
class Timers {
  readonly waiting: Array<{ callback: () => void; ms: number }> = [];
  set = (callback: () => void, ms: number) => {
    const entry = { callback, ms };
    this.waiting.push(entry);
    return () => { const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1); };
  };
  fire(ms: number): void {
    for (const entry of this.waiting.filter((candidate) => candidate.ms === ms)) {
      this.waiting.splice(this.waiting.indexOf(entry), 1);
      entry.callback();
    }
  }
}

let sequence = 0;
function event(timestamp: string, overrides: Partial<JobEvent> = {}): JobEvent {
  sequence += 1;
  return {
    eventId: `e-${String(sequence).padStart(5, '0')}`, timestamp, severity: 'info', eventType: 'job.started',
    message: `事件 ${sequence}`, vaultPath: VAULT, jobId: null, ...overrides,
  };
}

const lines = (events: JobEvent[]) => events.map((entry) => `${JSON.stringify(entry)}\n`).join('');

describe('activity log files (A-T1)', () => {
  it('reads every day file, skipping broken and half-written lines', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const old = [event('2026-10-14T01:00:00.000Z', { jobId: 'job-video', eventType: 'job.accepted' }), event('2026-10-14T02:00:00.000Z')];
    await mkdir(path.join(directory, 'events'), { recursive: true });
    await writeFile(path.join(directory, 'events', '2026-10-14.jsonl'), `${lines(old)}not json\n{"eventId":"x"}\n{"eventId":"half","timest`);
    const log = await ActivityLog.open(directory, { now: () => clock.now });
    const titles: Record<string, string> = { 'job-video': '影片標題', 'job-channel': '頻道' };
    const views = new ActivityViews(log, { sourceTitle: (id) => titles[id] });
    log.record(event('2026-10-15T05:00:00.000Z', { eventType: 'job.completed' }));
    await log.flush();

    const page = await views.query({}, { vaultPath: VAULT });
    expect(page.events.map((entry) => entry.eventType)).toEqual(['job.completed', 'job.started', 'job.accepted']);
    // The job learned its title after the event was written; parent and subscription are the event's own.
    expect(page.events[2]).toMatchObject({ sourceTitle: '影片標題' });
    expect(page.events[2]).not.toHaveProperty('parentJobId');
    expect(page.events[2]).not.toHaveProperty('subscriptionId');
    expect(page.log.skippedLines).toBe(2);
    expect((await readdir(path.join(directory, 'events'))).sort()).toEqual(['2026-10-14.jsonl', '2026-10-15.jsonl']);
    expect(page.retentionDays).toBe(RETENTION_DAYS);
    await log.close();
  });

  it('writes the events recorded within a second in one append, and answers with them before', async () => {
    const directory = await tempDirectory();
    const timers = new Timers();
    let appends = 0;
    const log = await ActivityLog.open(directory, {
      now: () => new Date('2026-10-15T06:00:00.000Z'), setTimer: timers.set,
      append: async (file, data) => { appends += 1; await appendFile(file, data); },
    });
    for (let index = 0; index < 5; index += 1) log.record(event('2026-10-15T05:00:00.000Z', { message: `第 ${index} 筆` }));
    expect(appends).toBe(0);
    expect(timers.waiting.filter((entry) => entry.ms === 1_000)).toHaveLength(1);
    expect((await new ActivityViews(log).query({}, { vaultPath: VAULT })).events).toHaveLength(5);

    timers.fire(1_000);
    await log.flush();
    expect(appends).toBe(1);
    expect(await readEventFiles(directory)).toHaveLength(5);
    await log.close();
  });

  it('writes each event to the file of its UTC day', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T23:30:00.000Z'));
    const log = await ActivityLog.open(directory, { now: () => clock.now });
    log.record(event('2026-10-15T23:59:59.999Z'));
    log.record(event('2026-10-16T00:00:00.000Z'));
    await log.flush();
    expect((await readdir(path.join(directory, 'events'))).sort()).toEqual(['2026-10-15.jsonl', '2026-10-16.jsonl']);
    await log.close();
  });

  it('persists DEBUG unchanged and returns it only when the query includes it (L1, L4)', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    let log = await ActivityLog.open(directory, { now: () => clock.now });
    log.record(event('2026-10-15T05:00:00.000Z', { severity: 'debug', eventType: 'job.accepted' }));
    log.record(event('2026-10-15T05:01:00.000Z', { severity: 'info', eventType: 'job.started' }));
    await log.close();
    log = await ActivityLog.open(directory, { now: () => clock.now });
    expect((await new ActivityViews(log).query({}, { vaultPath: VAULT })).events.map((entry) => entry.severity)).toEqual(['info', 'debug']);
    expect((await new ActivityViews(log).query({ severity: ['info', 'warning', 'error'] }, { vaultPath: VAULT })).events.map((entry) => entry.severity)).toEqual(['info']);
    expect(JSON.stringify(await readEventFiles(directory))).toContain('"severity":"debug"');
    await log.close();
  });
});

describe('retention (A-T2)', () => {
  it('removes expired day files at start and every hour', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const timers = new Timers();
    const segments = path.join(directory, 'events');
    await mkdir(segments, { recursive: true });
    const daysAgo = (days: number, hour = 6) => new Date(Date.UTC(2026, 9, 15 - days, hour)).toISOString();
    // 31 days ago: wholly expired; 30 days ago: the boundary day; 29 days ago: kept.
    await writeFile(path.join(segments, `${daysAgo(31).slice(0, 10)}.jsonl`), lines([event(daysAgo(31))]));
    await writeFile(path.join(segments, `${daysAgo(30).slice(0, 10)}.jsonl`), lines([event(daysAgo(30, 5), { message: '邊界前' }), event(daysAgo(30, 7), { message: '邊界後' })]));
    await writeFile(path.join(segments, `${daysAgo(29).slice(0, 10)}.jsonl`), lines([event(daysAgo(29), { message: '29 天前' })]));

    const log = await ActivityLog.open(directory, { now: () => clock.now, setTimer: timers.set });
    expect((await readdir(segments)).sort()).toEqual([`${daysAgo(30).slice(0, 10)}.jsonl`, `${daysAgo(29).slice(0, 10)}.jsonl`]);
    let messages = (await new ActivityViews(log).query({}, { vaultPath: VAULT })).events.map((entry) => entry.message);
    expect(messages).toEqual(['29 天前', '邊界後']);

    // A day later the boundary day has fully expired and the hourly purge removes its file.
    clock.advance(DAY);
    timers.fire(3_600_000);
    // The next hourly purge is set once this one has finished.
    await eventually(() => expect(timers.waiting.some((entry) => entry.ms === 3_600_000)).toBe(true));
    expect(await readdir(segments)).toEqual([`${daysAgo(29).slice(0, 10)}.jsonl`]);
    messages = (await new ActivityViews(log).query({}, { vaultPath: VAULT })).events.map((entry) => entry.message);
    expect(messages).toEqual(['29 天前']);
    await log.close();
  });

  it('counts local days across a UTC day boundary when the page asks for today', async () => {
    const directory = await tempDirectory();
    // 2026-10-15 00:30 in UTC+8 is 2026-10-14 16:30 UTC; local today began 2026-10-14T16:00Z, in the 10-14 UTC file.
    const clock = new Clock(new Date('2026-10-14T16:30:00.000Z'));
    const log = await ActivityLog.open(directory, { now: () => clock.now });
    log.record(event('2026-10-14T15:59:00.000Z', { message: '本機昨天 23:59' }));
    log.record(event('2026-10-14T16:01:00.000Z', { message: '本機今天 00:01' }));
    log.record(event('2026-10-15T01:00:00.000Z', { message: '本機今天 09:00' }));
    await log.flush();
    expect((await readdir(path.join(directory, 'events'))).sort()).toEqual(['2026-10-14.jsonl', '2026-10-15.jsonl']);

    const since = '2026-10-15T00:00:00+08:00';
    const page = await new ActivityViews(log).query({ since }, { vaultPath: VAULT });
    expect(page.events.map((entry) => entry.message)).toEqual(['本機今天 09:00', '本機今天 00:01']);
    // The page computes the same bound from the viewer's clock.
    const viewerNow = new Date('2026-10-14T16:30:00.000Z');
    expect(localDayStart(viewerNow).getTime()).toBe(new Date(viewerNow.getFullYear(), viewerNow.getMonth(), viewerNow.getDate()).getTime());
    await log.close();
  });
});

describe('cursor pages (A-T4)', () => {
  it('pages newest first without repeats or gaps while events are added and old files removed', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const log = await ActivityLog.open(directory, { now: () => clock.now });
    const stamps: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      // Pairs share a millisecond; the event ID orders them.
      const at = new Date(Date.UTC(2026, 9, 1, 0, 0, Math.floor(index / 2))).toISOString();
      stamps.push(at);
      log.record(event(at));
    }
    await log.flush();
    const all = (await new ActivityViews(log).query({ limit: 100 }, { vaultPath: VAULT }));
    const first = all.events;
    expect(first).toHaveLength(100);
    log.record(event('2026-10-15T05:59:00.000Z', { message: '翻頁中新增' }));
    await log.flush();
    const second = await new ActivityViews(log).query({ limit: 100, cursor: all.nextCursor! }, { vaultPath: VAULT });
    const third = await new ActivityViews(log).query({ limit: 100, cursor: second.nextCursor! }, { vaultPath: VAULT });
    const seen = [...first, ...second.events, ...third.events];
    expect(seen).toHaveLength(250);
    expect(new Set(seen.map((entry) => entry.eventId)).size).toBe(250);
    expect(seen.some((entry) => entry.message === '翻頁中新增')).toBe(false);
    expect(third.nextCursor).toBeNull();
    for (let index = 1; index < seen.length; index += 1) {
      const [a, b] = [seen[index - 1]!, seen[index]!];
      expect(a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.eventId > b.eventId)).toBe(true);
    }

    await expect(new ActivityViews(log).query({ limit: 100, cursor: all.nextCursor!, severity: ['error'] }, { vaultPath: VAULT }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(new ActivityViews(log).query({ cursor: 'garbage' }, { vaultPath: VAULT })).rejects.toMatchObject({ code: 'invalid_request' });
    await log.close();
  });

  it('keeps a cursor valid after the files before it are removed', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const log = await ActivityLog.open(directory, { now: () => clock.now });
    for (const day of [14, 15]) for (let hour = 0; hour < 3; hour += 1) log.record(event(new Date(Date.UTC(2026, 9, 10 + day - 14, hour)).toISOString()));
    // Older events on September 15 expire when the clock moves.
    for (let hour = 0; hour < 3; hour += 1) log.record(event(new Date(Date.UTC(2026, 8, 15, hour)).toISOString()));
    await log.flush();
    const page = await new ActivityViews(log).query({ limit: 4 }, { vaultPath: VAULT });
    clock.advance(DAY);
    await log.purge();
    const rest = await new ActivityViews(log).query({ limit: 10, cursor: page.nextCursor! }, { vaultPath: VAULT });
    expect(rest.events.map((entry) => entry.timestamp)).toEqual(['2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z']);
    await log.close();
  });
});

describe('filters (A-T5)', () => {
  it('filters by severity, type, job with its videos and retries, subscription, time and Vault', async () => {
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const jobs: Record<string, CollectionJob> = {
      channel: { id: 'channel', kind: 'youtube.channel', parentId: null, source: { type: 'youtube', id: 'UC1', url: 'u', title: '頻道一' } } as CollectionJob,
      child: { id: 'child', kind: 'youtube.video', parentId: 'channel', source: { type: 'youtube', id: 'v1', url: 'u', title: '影片一' } } as CollectionJob,
    };
    const log = ActivityLog.memory({ now: () => clock.now });
    const views = new ActivityViews(log, { sourceTitle: (id) => jobs[id]?.source.title });
    log.record(event('2026-10-15T01:00:00.000Z', { jobId: 'channel', severity: 'debug', eventType: 'job.accepted', subscriptionId: 'UC1' }));
    log.record(event('2026-10-15T01:01:00.000Z', { jobId: 'child', parentJobId: 'channel', subscriptionId: 'UC1', eventType: 'document.saved', documentId: 'youtube:v1' }));
    log.record(event('2026-10-15T01:02:00.000Z', { jobId: 'child', parentJobId: 'channel', subscriptionId: 'UC1', severity: 'warning', eventType: 'job.retry_scheduled' }));
    log.record(event('2026-10-15T01:03:00.000Z', { jobId: 'other', severity: 'error', eventType: 'job.failed', subscriptionId: 'UC2' }));
    log.record(event('2026-10-15T01:04:00.000Z', { jobId: 'again', eventType: 'job.retry_requested', retryOf: 'other' }));
    log.record(event('2026-10-15T01:05:00.000Z', { eventType: 'subscription.paused', sourceId: 'UC1', subscriptionId: 'UC1' }));
    log.record(event('2026-10-15T01:06:00.000Z', { vaultPath: '/vaults/b', eventType: 'job.started' }));
    log.record(event('2026-10-15T01:07:00.000Z', { vaultPath: null, eventType: 'vault.imported' }));
    const types = async (query: Parameters<ActivityViews['query']>[0], vaultPath: string | null = VAULT) =>
      (await views.query(query, { vaultPath })).events.map((entry) => entry.eventType).reverse();

    expect(await types({})).toEqual(['job.accepted', 'document.saved', 'job.retry_scheduled', 'job.failed', 'job.retry_requested', 'subscription.paused', 'vault.imported']);
    expect(await types({}, null)).toHaveLength(8);
    expect(await types({ severity: ['warning', 'error'] })).toEqual(['job.retry_scheduled', 'job.failed']);
    expect(await types({ severity: ['info', 'warning', 'error'] })).toEqual([
      'document.saved', 'job.retry_scheduled', 'job.failed', 'job.retry_requested', 'subscription.paused', 'vault.imported',
    ]);
    expect(await types({ severity: ['error'] })).toEqual(['job.failed']);
    expect(await types({ eventType: ['document.saved'] })).toEqual(['document.saved']);
    expect(await types({ jobId: 'channel' })).toEqual(['job.accepted', 'document.saved', 'job.retry_scheduled']);
    expect(await types({ jobId: 'other' })).toEqual(['job.failed', 'job.retry_requested']);
    expect(await types({ subscriptionId: 'UC1' })).toEqual(['job.accepted', 'document.saved', 'job.retry_scheduled', 'subscription.paused']);
    expect(await types({ since: '2026-10-15T01:02:00.000Z', until: '2026-10-15T01:04:00.000Z' })).toEqual(['job.retry_scheduled', 'job.failed']);
  });
});

describe('masking (A-T6)', () => {
  it('masks credentials and shortens long text on disk and in answers, stored entries included', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const token = 'a'.repeat(64);
    const secretMessage = `請求失敗 Authorization: Bearer sk-live-123 Cookie: SID=abc; HSID=def https://x.test/v?id=1&token=t0p&sig=s1g agent ${token}`;
    // Stored before the token was protected, so only the masking on read hides it.
    await mkdir(path.join(directory, 'events'), { recursive: true });
    await writeFile(path.join(directory, 'events', '2026-10-15.jsonl'), lines([event('2026-10-15T01:00:00.000Z', { message: `stored agent ${token}` })]));
    const log = await ActivityLog.open(directory, { now: () => clock.now });
    protectSecret(token);
    log.record(event('2026-10-15T02:00:00.000Z', { severity: 'error', message: secretMessage, detail: `${'x'.repeat(10_000)}\nERROR: cookie=SECRET; Authorization: Basic Zm9vOmJhcg== ${token}` }));
    log.record(event('2026-10-15T03:00:00.000Z', { message: '長'.repeat(2000) }));
    await log.flush();

    const disk = JSON.stringify((await readEventFiles(directory)).filter((entry) => !entry.message.startsWith('stored')));
    const answer = JSON.stringify((await new ActivityViews(log).query({}, { vaultPath: VAULT })).events);
    for (const text of [disk, answer]) {
      for (const secret of ['sk-live-123', 'SID=abc', 't0p', 's1g', token, 'SECRET', 'Zm9vOmJhcg==']) expect(text).not.toContain(secret);
      expect(text).toContain('[已遮蔽]');
    }
    expect(answer).toContain('stored agent [已遮蔽]');
    const [long, masked] = (await new ActivityViews(log).query({}, { vaultPath: VAULT })).events;
    expect([...long!.message].length).toBe(500);
    expect([...masked!.detail!].length).toBe(2000);
    expect(masked!.detail!.endsWith('[已遮蔽]')).toBe(true);
    await log.close();
  });

  it('keeps ordinary text and the start or end of long text', () => {
    expect(redact('無法連線到 YouTube，請稍後再試。')).toBe('無法連線到 YouTube，請稍後再試。');
    expect(redact('https://www.youtube.com/watch?v=abc&list=PL1')).toBe('https://www.youtube.com/watch?v=abc&list=PL1');
    expect(redact('失敗（Authorization: Bearer abc.def）請重試')).toBe('失敗（Authorization: [已遮蔽]）請重試');
    expect(limitText('abcdef', 4, 'head')).toBe('abc…');
    expect(limitText('abcdef', 4, 'tail')).toBe('…def');
  });
});

describe('write failures (A-T7)', () => {
  it('reports a failing log, keeps events waiting and writes them in order once writing works again', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const timers = new Timers();
    let failing = true;
    const log = await ActivityLog.open(directory, {
      now: () => clock.now, setTimer: timers.set,
      append: async (file, data) => {
        if (failing) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        const { appendFile } = await import('node:fs/promises');
        await appendFile(file, data);
      },
    });
    log.record(event('2026-10-15T05:00:00.000Z', { message: '第一筆' }));
    log.record(event('2026-10-15T05:00:01.000Z', { message: '第二筆' }));
    await log.flush();
    expect(log.health()).toMatchObject({ state: 'failing', pending: 2, dropped: 0, lastError: 'EACCES: permission denied' });
    expect(log.health().lastFailureAt).toBe(clock.now.toISOString());
    // Waiting events still show in answers.
    expect((await new ActivityViews(log).query({}, { vaultPath: VAULT })).events.map((entry) => entry.message)).toEqual(['第二筆', '第一筆']);

    failing = false;
    timers.fire(30_000);
    await log.flush();
    expect(log.health()).toMatchObject({ state: 'ok', pending: 0, dropped: 0 });
    expect((await readEventFiles(directory)).map((entry) => entry.message)).toEqual(['第一筆', '第二筆']);
    await log.close();
  });

  it('tries no write and logs no error until the retry 30 seconds after a failure', async () => {
    const directory = await tempDirectory();
    const timers = new Timers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failing = true;
    let appends = 0;
    const log = await ActivityLog.open(directory, {
      now: () => new Date('2026-10-15T06:00:00.000Z'), setTimer: timers.set,
      append: async (file, data) => {
        appends += 1;
        if (failing) throw new Error('ENOSPC: no space left on device');
        await appendFile(file, data);
      },
    });
    try {
      log.record(event('2026-10-15T05:00:00.000Z'));
      timers.fire(1_000);
      await log.flush();
      for (let index = 0; index < 20; index += 1) log.record(event('2026-10-15T05:00:01.000Z'));
      await log.flush();
      expect(timers.waiting.map((entry) => entry.ms)).not.toContain(1_000);
      expect(appends).toBe(1);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(log.health()).toMatchObject({ state: 'failing', pending: 21 });

      failing = false;
      timers.fire(30_000);
      await log.flush();
      expect(appends).toBe(2);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(log.health()).toMatchObject({ state: 'ok', pending: 0 });
      expect(await readEventFiles(directory)).toHaveLength(21);
      await log.close();
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps a half-written batch from joining the events written after it', async () => {
    const directory = await tempDirectory();
    const timers = new Timers();
    let partial = true;
    const log = await ActivityLog.open(directory, {
      now: () => new Date('2026-10-15T06:00:00.000Z'), setTimer: timers.set,
      append: async (file, data) => {
        if (partial) {
          partial = false;
          await appendFile(file, data.slice(0, 40));
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        await appendFile(file, data);
      },
    });
    log.record(event('2026-10-15T05:00:00.000Z', { message: '第一筆' }));
    await log.flush();
    expect(log.health()).toMatchObject({ state: 'failing', pending: 1 });
    timers.fire(30_000);
    await log.flush();
    log.record(event('2026-10-15T05:00:01.000Z', { message: '第二筆' }));
    await log.close();

    const lines = (await readFile(path.join(directory, 'events', '2026-10-15.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    const reopened = await ActivityLog.open(directory, { now: () => new Date('2026-10-15T06:00:00.000Z'), setTimer: () => () => undefined });
    expect((await new ActivityViews(reopened).query({}, { vaultPath: VAULT })).events.map((entry) => entry.message)).toEqual(['第二筆', '第一筆']);
    expect(reopened.health().skippedLines).toBe(1);
    await reopened.close();
  });

  it('drops the oldest waiting events beyond the limit and names their jobs', async () => {
    const directory = await tempDirectory();
    const dropped: JobEvent[] = [];
    const log = await ActivityLog.open(directory, {
      now: () => new Date('2026-10-15T06:00:00.000Z'), setTimer: () => () => undefined,
      append: async () => { throw new Error('disk full'); },
      onDropped: (entry) => dropped.push(entry),
    });
    for (let index = 0; index < 1005; index += 1) log.record(event('2026-10-15T05:00:00.000Z', { jobId: `job-${index}` }));
    await log.flush();
    expect(log.health()).toMatchObject({ state: 'failing', pending: 1000, dropped: 5 });
    expect(dropped.map((entry) => entry.jobId)).toEqual(['job-0', 'job-1', 'job-2', 'job-3', 'job-4']);
    await log.close();
  });

  it('recovers when the events directory becomes writable again', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const directory = await tempDirectory();
    const timers = new Timers();
    await mkdir(path.join(directory, 'events'), { mode: 0o500 });
    const log = await ActivityLog.open(directory, { now: () => new Date('2026-10-15T06:00:00.000Z'), setTimer: timers.set });
    log.record(event('2026-10-15T05:01:00.000Z', { message: '暫時無法寫入' }));
    await log.flush();
    expect(log.health()).toMatchObject({ state: 'failing', pending: 1 });
    await chmod(path.join(directory, 'events'), 0o700);
    timers.fire(30_000);
    await log.flush();
    expect(log.health()).toMatchObject({ state: 'ok', pending: 0 });
    expect((await readEventFiles(directory)).map((entry) => entry.message)).toEqual(['暫時無法寫入']);
    await log.close();
  });
});

describe('event IDs and kinds (#262)', () => {
  const recorded = { message: '事件', vaultPath: VAULT, jobId: null } as const;
  const sequenceOf = (entry: JobEvent) => Number(entry.eventId.slice(0, 12));

  it('continues the sequence after a restart without repeating or skipping a number, even after the clock went back', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    let log = await ActivityLog.open(directory, { now: () => clock.now });
    for (let index = 0; index < 3; index += 1) { log.event({ ...recorded, eventType: 'job.started' }); clock.advance(1_000); }
    // The newest event by time is no longer the one with the highest sequence.
    clock.advance(-60 * 60_000);
    log.event({ ...recorded, eventType: 'job.completed' });
    await log.close();

    log = await ActivityLog.open(directory, { now: () => clock.now });
    log.event({ ...recorded, eventType: 'job.started' });
    log.event({ ...recorded, eventType: 'job.completed' });
    await log.close();

    const sequences = (await readEventFiles(directory)).map(sequenceOf).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('records an event without a severity at its kind\'s default, and keeps a severity the emitter gives', async () => {
    const log = ActivityLog.memory({ now: () => new Date('2026-10-15T06:00:00.000Z') });
    log.event({ ...recorded, eventType: 'schedule.dispatched' });
    log.event({ ...recorded, eventType: 'fake.rate_limited' });
    log.event({ ...recorded, eventType: 'job.started', severity: 'debug' });
    const events = (await new ActivityViews(log).query({}, { vaultPath: VAULT })).events;
    expect(events.map((entry) => [entry.eventType, entry.severity])).toEqual([
      ['job.started', 'debug'], ['fake.rate_limited', 'warning'], ['schedule.dispatched', 'debug'],
    ]);
  });

  it('skips a stored line whose kind the catalog does not list', async () => {
    const directory = await tempDirectory();
    await mkdir(path.join(directory, 'events'), { recursive: true });
    const stored = [event('2026-10-15T01:00:00.000Z'), event('2026-10-15T02:00:00.000Z', { eventType: 'job.archived' as JobEvent['eventType'] })];
    await writeFile(path.join(directory, 'events', '2026-10-15.jsonl'), lines(stored));
    const log = await ActivityLog.open(directory, { now: () => new Date('2026-10-15T06:00:00.000Z') });
    const page = await new ActivityViews(log).query({}, { vaultPath: VAULT });
    expect(page.events.map((entry) => entry.eventType)).toEqual(['job.started']);
    expect(page.log.skippedLines).toBe(1);
    await log.close();
  });
});

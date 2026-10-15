import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityLog, RETENTION_DAYS } from '../../src/activity/activity-log.js';
import { limitText, redact } from '../../src/activity/redact.js';
import type { CollectionJob, JobEvent } from '../../src/core/types.js';
import { localDayStart } from '../../src/web/activity-presentation.js';
import { readEventFiles } from './event-files.js';

// The device activity log: day files with a 30-day retention, the earlier single file read along,
// newest-first cursor pages, filters, masking and write failures that are reported, not lost.

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

describe('activity log files and compatibility (A-T1)', () => {
  it('reads the earlier single file with the day files, skipping broken and half-written lines', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const old = [event('2026-10-14T01:00:00.000Z', { jobId: 'job-video', eventType: 'job.accepted' }), event('2026-10-14T02:00:00.000Z')];
    await writeFile(path.join(directory, 'events.jsonl'), `${lines(old)}not json\n{"eventId":"x"}\n{"eventId":"half","timest`);
    const log = await ActivityLog.open(directory, {
      now: () => clock.now,
      lookupJob: (id): CollectionJob | undefined => (id === 'job-video'
        ? { id, kind: 'youtube.video', parentId: 'job-channel', source: { type: 'youtube', id: 'v1', url: 'u', title: '影片標題' } } as CollectionJob
        : id === 'job-channel'
          ? { id, kind: 'youtube.channel', parentId: null, source: { type: 'youtube', id: 'UC1', url: 'u', title: '頻道' } } as CollectionJob
          : undefined),
    });
    log.record(event('2026-10-15T05:00:00.000Z', { eventType: 'job.completed' }));
    await log.flush();

    const page = await log.query({}, { vaultPath: VAULT });
    expect(page.events.map((entry) => entry.eventType)).toEqual(['job.completed', 'job.started', 'job.accepted']);
    expect(page.events[2]).toMatchObject({ sourceTitle: '影片標題', parentJobId: 'job-channel', subscriptionId: 'UC1' });
    expect(page.log.skippedLines).toBe(2);
    expect(await readdir(path.join(directory, 'events'))).toEqual(['2026-10-15.jsonl']);
    expect(page.retentionDays).toBe(RETENTION_DAYS);
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
});

describe('retention (A-T2)', () => {
  it('removes expired day files and expired lines of the earlier file, at start and every hour', async () => {
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
    await writeFile(path.join(directory, 'events.jsonl'), lines([event(daysAgo(40), { message: '舊檔過期' }), event(daysAgo(2), { message: '舊檔保留' })]));

    const log = await ActivityLog.open(directory, { now: () => clock.now, setTimer: timers.set });
    expect((await readdir(segments)).sort()).toEqual([`${daysAgo(30).slice(0, 10)}.jsonl`, `${daysAgo(29).slice(0, 10)}.jsonl`]);
    expect(await readFile(path.join(directory, 'events.jsonl'), 'utf8')).not.toContain('舊檔過期');
    let messages = (await log.query({}, { vaultPath: VAULT })).events.map((entry) => entry.message);
    expect(messages).toEqual(['舊檔保留', '29 天前', '邊界後']);

    // A day later the boundary day has fully expired and the hourly purge removes its file.
    clock.advance(DAY);
    timers.fire(3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readdir(segments)).toEqual([`${daysAgo(29).slice(0, 10)}.jsonl`]);
    messages = (await log.query({}, { vaultPath: VAULT })).events.map((entry) => entry.message);
    expect(messages).toEqual(['舊檔保留', '29 天前']);
    expect(timers.waiting.some((entry) => entry.ms === 3_600_000)).toBe(true);

    // Once every line of the earlier file expired, the file goes.
    clock.advance(30 * DAY);
    await log.purge();
    await expect(readFile(path.join(directory, 'events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    const page = await log.query({ since }, { vaultPath: VAULT });
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
    const all = (await log.query({ limit: 100 }, { vaultPath: VAULT }));
    const first = all.events;
    expect(first).toHaveLength(100);
    log.record(event('2026-10-15T05:59:00.000Z', { message: '翻頁中新增' }));
    await log.flush();
    const second = await log.query({ limit: 100, cursor: all.nextCursor! }, { vaultPath: VAULT });
    const third = await log.query({ limit: 100, cursor: second.nextCursor! }, { vaultPath: VAULT });
    const seen = [...first, ...second.events, ...third.events];
    expect(seen).toHaveLength(250);
    expect(new Set(seen.map((entry) => entry.eventId)).size).toBe(250);
    expect(seen.some((entry) => entry.message === '翻頁中新增')).toBe(false);
    expect(third.nextCursor).toBeNull();
    for (let index = 1; index < seen.length; index += 1) {
      const [a, b] = [seen[index - 1]!, seen[index]!];
      expect(a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.eventId > b.eventId)).toBe(true);
    }

    await expect(log.query({ limit: 100, cursor: all.nextCursor!, severity: ['error'] }, { vaultPath: VAULT }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(log.query({ cursor: 'garbage' }, { vaultPath: VAULT })).rejects.toMatchObject({ code: 'invalid_request' });
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
    const page = await log.query({ limit: 4 }, { vaultPath: VAULT });
    clock.advance(DAY);
    await log.purge();
    const rest = await log.query({ limit: 10, cursor: page.nextCursor! }, { vaultPath: VAULT });
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
    const log = ActivityLog.memory({ now: () => clock.now, lookupJob: (id) => jobs[id] });
    log.record(event('2026-10-15T01:00:00.000Z', { jobId: 'channel', eventType: 'job.accepted', subscriptionId: 'UC1' }));
    // Written before subscriptions and parents were recorded; the job record fills them in.
    log.record(event('2026-10-15T01:01:00.000Z', { jobId: 'child', eventType: 'document.saved', documentId: 'youtube:v1' }));
    log.record(event('2026-10-15T01:02:00.000Z', { jobId: 'child', severity: 'warning', eventType: 'job.retry_scheduled' }));
    log.record(event('2026-10-15T01:03:00.000Z', { jobId: 'other', severity: 'error', eventType: 'job.failed', subscriptionId: 'UC2' }));
    log.record(event('2026-10-15T01:04:00.000Z', { jobId: 'again', eventType: 'job.retry_requested', retryOf: 'other' }));
    log.record(event('2026-10-15T01:05:00.000Z', { eventType: 'subscription.paused', sourceId: 'UC1' }));
    log.record(event('2026-10-15T01:06:00.000Z', { vaultPath: '/vaults/b', eventType: 'job.started' }));
    log.record(event('2026-10-15T01:07:00.000Z', { vaultPath: null, eventType: 'vault.restored' }));
    const types = async (query: Parameters<ActivityLog['query']>[0], vaultPath: string | null = VAULT) =>
      (await log.query(query, { vaultPath })).events.map((entry) => entry.eventType).reverse();

    expect(await types({})).toEqual(['job.accepted', 'document.saved', 'job.retry_scheduled', 'job.failed', 'job.retry_requested', 'subscription.paused', 'vault.restored']);
    expect(await types({}, null)).toHaveLength(8);
    expect(await types({ severity: ['warning', 'error'] })).toEqual(['job.retry_scheduled', 'job.failed']);
    expect(await types({ eventType: ['document.saved'] })).toEqual(['document.saved']);
    expect(await types({ jobId: 'channel' })).toEqual(['job.accepted', 'document.saved', 'job.retry_scheduled']);
    expect(await types({ jobId: 'other' })).toEqual(['job.failed', 'job.retry_requested']);
    expect(await types({ subscriptionId: 'UC1' })).toEqual(['job.accepted', 'document.saved', 'job.retry_scheduled', 'subscription.paused']);
    expect(await types({ since: '2026-10-15T01:02:00.000Z', until: '2026-10-15T01:04:00.000Z' })).toEqual(['job.retry_scheduled', 'job.failed']);
  });
});

describe('masking (A-T6)', () => {
  it('masks credentials and shortens long text on disk and in answers, older entries included', async () => {
    const directory = await tempDirectory();
    const clock = new Clock(new Date('2026-10-15T06:00:00.000Z'));
    const token = 'a'.repeat(64);
    const secretMessage = `請求失敗 Authorization: Bearer sk-live-123 Cookie: SID=abc; HSID=def https://x.test/v?id=1&token=t0p&sig=s1g agent ${token}`;
    await writeFile(path.join(directory, 'events.jsonl'), lines([event('2026-10-15T01:00:00.000Z', { message: 'Bearer legacy-secret-value' })]));
    const log = await ActivityLog.open(directory, { now: () => clock.now });
    log.protectSecret(token);
    log.record(event('2026-10-15T02:00:00.000Z', { severity: 'error', message: secretMessage, detail: `${'x'.repeat(10_000)}\nERROR: cookie=SECRET; Authorization: Basic Zm9vOmJhcg== ${token}` }));
    log.record(event('2026-10-15T03:00:00.000Z', { message: '長'.repeat(2000) }));
    await log.flush();

    const disk = JSON.stringify(await readEventFiles(directory));
    const answer = JSON.stringify((await log.query({}, { vaultPath: VAULT })).events);
    for (const text of [disk, answer]) {
      for (const secret of ['sk-live-123', 'SID=abc', 't0p', 's1g', token, 'SECRET', 'Zm9vOmJhcg==']) expect(text).not.toContain(secret);
      expect(text).toContain('[已遮蔽]');
    }
    expect(answer).not.toContain('legacy-secret-value');
    const [long, masked] = (await log.query({}, { vaultPath: VAULT })).events;
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
    expect((await log.query({}, { vaultPath: VAULT })).events.map((entry) => entry.message)).toEqual(['第二筆', '第一筆']);

    failing = false;
    timers.fire(30_000);
    await log.flush();
    expect(log.health()).toMatchObject({ state: 'ok', pending: 0, dropped: 0 });
    expect((await readEventFiles(directory)).map((entry) => entry.message)).toEqual(['第一筆', '第二筆']);
    await log.close();
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
    expect((await reopened.query({}, { vaultPath: VAULT })).events.map((entry) => entry.message)).toEqual(['第二筆', '第一筆']);
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

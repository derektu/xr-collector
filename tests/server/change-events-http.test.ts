import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCursor, type Change, type ChangeBatch } from '../../src/core/change-feed.js';
import type { SearchResponse, SearchStatus, TranscriptSearch } from '../../src/core/types.js';
import type { Pacing, PacingEvent } from '../../src/pacing/pacing-gate.js';
import type { DiscoveredYouTubeVideo } from '../../src/plugins/youtube/adapter.js';
import { CollectorRuntime, type CollectorRuntimeOptions } from '../../src/runtime/collector-runtime.js';
import type { DeviceUpdateStatus, UpdateAccess } from '../../src/updates/types.js';
import { withYouTube } from '../support/youtube-sources.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CHANNEL = { id: 'UCchangeevents00000000000', title: 'Changes', url: 'https://www.youtube.com/channel/UCchangeevents00000000000' };
const video = (id: string): DiscoveredYouTubeVideo => ({ id, title: `Video ${id}`, url: `https://www.youtube.com/watch?v=${id}`, publishedAt: null, upcoming: false });

interface StreamEvent { event: string; id: string | null; data: { revision: string; changes?: Change[] } }

/** Reads the event stream at `base` until closed. */
async function openEvents(base: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
  const events: StreamEvent[] = [];
  if (response.ok) {
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const field = (name: string) => block.split('\n').find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
            const event = field('event');
            if (event) events.push({ event, id: field('id'), data: JSON.parse(field('data')!) });
          }
        }
      } catch { /* closed by the test */ }
    })();
  }
  const changes = () => events.filter((event) => event.event === 'change').flatMap((event) => event.data.changes!);
  return {
    response, events, changes,
    batches: () => events.filter((event) => event.event === 'change').map((event) => event.data as ChangeBatch),
    /** Resolves with the first event that matches. */
    next: (match: (event: StreamEvent) => boolean, label: string) => vi.waitFor(() => {
      const found = events.find(match);
      if (!found) throw new Error(`no event: ${label}`);
      return found;
    }, { timeout: 5_000 }),
    /** Resolves once a published change matches. */
    change: (match: (change: Change) => boolean, label: string) => vi.waitFor(() => {
      const found = changes().find(match);
      if (!found) throw new Error(`no change: ${label}`);
      return found;
    }, { timeout: 5_000 }),
    close: () => controller.abort(),
  };
}

const number = (revision: string | null) => parseCursor(revision)!.number;

class MemorySearch implements TranscriptSearch {
  statusChanged: () => void = () => undefined;
  status(): SearchStatus { return { state: 'ready', indexedDocuments: 0, lastRebuiltAt: null }; }
  async index(): Promise<void> {}
  async remove(): Promise<void> {}
  async search(): Promise<SearchResponse> { return { results: [], total: 0 } as unknown as SearchResponse; }
  async rebuild(): Promise<void> { this.statusChanged(); }
}

class FakePacing implements Pacing {
  readonly group = 'youtube';
  private readonly listeners = new Set<(event: PacingEvent) => void>();
  status() { return { state: 'idle' as const, cooldownUntil: null, level: 0, waitRangeMs: { min: 0, max: 0 } }; }
  subscribe(listener: (event: PacingEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: PacingEvent) { for (const listener of this.listeners) listener(event); }
}

class FakeUpdates implements UpdateAccess {
  private readonly listeners = new Set<() => void>();
  private value = { phase: 'idle' } as unknown as DeviceUpdateStatus;
  status() { return this.value; }
  async check() { this.value = { phase: 'up_to_date' } as unknown as DeviceUpdateStatus; for (const listener of this.listeners) listener(); return this.value; }
  async download() { return this.value; }
  async apply() { return this.value; }
  async cancel() { return this.value; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

async function start(options: { vault?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-change-events-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(tmpdir(), 'xr-change-events-exports-'));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  const search = new MemorySearch();
  const pacing = new FakePacing();
  const updates = new FakeUpdates();
  const listed: DiscoveredYouTubeVideo[] = [video('chgvideo001')];
  const runtime = await CollectorRuntime.start({
    profilePath: root,
    ...(options.vault === false ? {} : { explicitVaultPath: path.join(root, 'vault') }),
    workspace: withYouTube({
      capture: { capture: async (ref) => ({
        videoId: ref.videoId, sourceUrl: ref.canonicalUrl, title: `Video ${ref.videoId}`, channelId: CHANNEL.id,
        channelTitle: CHANNEL.title, publishedAt: null, languageCode: 'en', languageName: 'English', subtitleKind: 'manual', bodyMarkdown: 'Body.',
      }) },
      channelSource: { resolve: async () => CHANNEL, listVideos: async (_channel, page) => listed.slice(page.offset, page.offset + page.limit) },
      pacing: [pacing],
      searchBinary: 'unused', searchData: path.join(root, 'search'), exportFolder: path.join(outside, 'exports'), backupFolder: path.join(outside, 'backups'),
      createSearch: async (_root, statusChanged) => { search.statusChanged = statusChanged; return { search, close: async () => undefined }; },
    }),
    updates,
    agentSettingsFile: path.join(root, 'agent-settings.json'),
    skillPath: path.resolve('skills/xr-collector-agent'),
    uiPort: 0,
  } satisfies CollectorRuntimeOptions);
  cleanups.push(() => runtime.close());
  const ui = runtime.server.url;
  const send = (method: string, route: string, body?: unknown) => fetch(`${ui}${route}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { runtime, ui, send, pacing, updates, listed, outside };
}

describe('change events', () => {
  it('publishes a scoped change for each kind of data change, under revisions that increase one by one', async () => {
    const { runtime, ui, send, pacing, updates } = await start();
    const events = await openEvents(ui);
    /** Runs `action` and waits for one more change that `match` accepts than there were before it. */
    const another = async (action: () => unknown, match: (change: Change) => boolean, label: string) => {
      const before = events.changes().filter(match).length;
      await action();
      await vi.waitFor(() => expect(events.changes().filter(match).length, label).toBeGreaterThan(before));
    };
    expect(events.response.headers.get('content-type')).toContain('text/event-stream');
    const hello = await events.next((event) => event.event === 'hello', 'hello');
    expect(parseCursor(hello.data.revision)?.epoch).toBe(runtime.changes.epoch);

    const collected = await send('POST', '/api/items', { url: 'https://www.youtube.com/watch?v=chgsingle01' });
    expect(collected.status).toBe(202);
    const itemJob = (await collected.json()).job.id as string;
    const queued = events.batches().find((batch) => batch.changes.some((change) => change.kind === 'job' && change.id === itemJob));
    expect(queued, 'the accepted job is published before the response').toBeDefined();
    expect(number(collected.headers.get('XR-Revision'))).toBeGreaterThanOrEqual(number(queued!.revision));
    await events.change((change) => change.kind === 'job' && change.id === itemJob && change.state === 'completed', 'item job completed');
    await events.change((change) => change.kind === 'document' && change.id === 'youtube:chgsingle01', 'document saved');
    await events.change((change) => change.kind === 'activity', 'activity recorded');

    const added = await send('POST', '/api/subscriptions', { url: CHANNEL.url });
    const addJob = (await added.json()).job.id as string;
    await events.change((change) => change.kind === 'subscription' && change.id === CHANNEL.id, 'subscription added');
    const check = await vi.waitFor(async () => {
      const job = (await (await fetch(`${ui}/api/jobs/${addJob}`)).json()).job;
      expect(job.result?.followUpJobId).toBeTruthy();
      return job.result.followUpJobId as string;
    });
    await events.change((change) => change.kind === 'job' && change.id === check && change.state === 'completed', 'check completed');
    const finished = (await (await fetch(`${ui}/api/jobs/${check}`)).json()).job;
    const subscription = (await (await fetch(`${ui}/api/subscriptions/youtube/${CHANNEL.id}`)).json()).subscription;
    expect(subscription.lastCheckedAt, 'the check end is recorded when its job reads as completed').toBe(finished.finishedAt);
    await events.change((change) => change.kind === 'document' && change.id === 'youtube:chgvideo001', 'check collected its video');

    expect((await send('DELETE', '/api/documents/youtube:chgsingle01')).status).toBe(200);
    await vi.waitFor(() => expect(events.changes().filter((change) => change.kind === 'document' && change.id === 'youtube:chgsingle01').length).toBeGreaterThan(0));
    const deletedAt = events.batches().length;

    expect((await send('PUT', '/api/schedule', { enabled: false })).status).toBe(200);
    await events.change((change) => change.kind === 'schedule', 'schedule switch saved');
    expect(events.batches().slice(deletedAt).length).toBeGreaterThan(0);

    expect((await send('POST', '/api/search/rebuild')).status).toBe(200);
    await events.change((change) => change.kind === 'search', 'search rebuilt');

    const connectivity = (change: Change) => change.kind === 'connectivity';
    await another(() => runtime.pause.set('offline', true), connectivity, 'went offline');
    await another(() => runtime.pause.set('offline', false), connectivity, 'back online');

    const cooldown = (change: Change) => change.kind === 'pacing' && change.group === 'youtube';
    await another(() => pacing.emit({ type: 'rate_limited', until: new Date(Date.now() + 60_000).toISOString(), level: 1 }), cooldown, 'cooldown started');
    await another(() => pacing.emit({ type: 'cooldown_ended' }), cooldown, 'cooldown ended');

    await updates.check();
    await events.change((change) => change.kind === 'update', 'update status');

    expect((await send('PUT', '/api/device/notifications', { enabled: false })).status).toBe(200);
    await events.change((change) => change.kind === 'notifications', 'notification setting');

    const exported = await send('POST', '/api/vault/export', {});
    expect(exported.status).toBe(200);
    await events.change((change) => change.kind === 'vault' && change.scope === 'transfer', 'vault export');

    const subscriptionChange = (change: Change) => change.kind === 'subscription' && change.id === CHANNEL.id;
    await another(async () => expect((await send('PATCH', `/api/subscriptions/youtube/${CHANNEL.id}`, { enabled: false })).status).toBe(200),
      subscriptionChange, 'subscription changed');
    await another(async () => expect((await send('DELETE', `/api/subscriptions/youtube/${CHANNEL.id}`)).status).toBe(200),
      subscriptionChange, 'subscription removed');


    const revisions = events.batches().map((batch) => number(batch.revision));
    expect(revisions).toEqual(revisions.map((_value, index) => revisions[0]! + index));
    expect(revisions[0]).toBe(number(hello.data.revision) + 1);
    events.close();
  });

  it('names on every API response a revision its data is at least as new as', async () => {
    const { runtime, ui, send } = await start();
    const before = runtime.changes.revision;
    const read = await fetch(`${ui}/api/subscriptions`);
    expect(read.headers.get('XR-Revision')).toBe(before);
    const write = await send('PUT', '/api/schedule', { enabled: false });
    expect(number(write.headers.get('XR-Revision')), 'a write includes its own change').toBeGreaterThan(number(before));
    expect(write.headers.get('XR-Revision')).toBe(runtime.changes.revision);
    expect((await fetch(`${ui}/api/schedule`)).headers.get('XR-Revision')).toBe(runtime.changes.revision);
  });

  it('catches a reconnecting reader up from its last revision, and resets one it cannot', async () => {
    const { ui, send } = await start();
    const first = await openEvents(ui);
    const hello = await first.next((event) => event.event === 'hello', 'hello');
    first.close();
    await send('PUT', '/api/schedule', { enabled: false });
    await send('PUT', '/api/schedule', { enabled: true });

    const again = await openEvents(ui, { 'Last-Event-ID': hello.data.revision });
    await again.change((change) => change.kind === 'schedule', 'missed schedule change');
    expect(again.events.find((event) => event.event === 'reset')).toBeUndefined();
    const replayed = again.batches().map((batch) => number(batch.revision));
    expect(replayed[0]).toBe(number(hello.data.revision) + 1);
    again.close();

    const other = await openEvents(ui, { 'Last-Event-ID': 'ffffffff:1' });
    const reset = await other.next((event) => event.event === 'reset', 'reset');
    expect(reset.data.revision).toBe(hello.data.revision.replace(/:\d+$/u, `:${replayed.at(-1)}`));
    other.close();
  });

  it('answers a waiting read with the next matching changes, or nothing once the wait ends', async () => {
    const { ui, send } = await start();
    const start0 = await (await fetch(`${ui}/api/changes`)).json();
    expect(start0).toEqual({ revision: expect.any(String), reset: false, batches: [] });
    const waiting = fetch(`${ui}/api/changes?after=${start0.revision}&kind=schedule&wait=10`).then((response) => response.json());
    await send('PUT', '/api/schedule', { enabled: false });
    const answer = await waiting;
    expect(answer.reset).toBe(false);
    expect(answer.batches).toEqual([expect.objectContaining({ changes: [{ kind: 'schedule' }] })]);

    const began = Date.now();
    const empty = await (await fetch(`${ui}/api/changes?after=${answer.revision}&kind=update&wait=1`)).json();
    expect(empty).toMatchObject({ reset: false, batches: [] });
    expect(Date.now() - began).toBeGreaterThanOrEqual(900);
    expect((await fetch(`${ui}/api/changes?after=nope`)).status).toBe(400);
    expect((await fetch(`${ui}/api/changes?after=${answer.revision}&kind=nope`)).status).toBe(400);
    expect(await (await fetch(`${ui}/api/changes?after=ffffffff:1`)).json()).toMatchObject({ reset: true, batches: [] });
  });

  it('serves the stream to an authorized Agent and to the UI only under its own host name, before a Vault is set', async () => {
    const { runtime, ui, outside } = await start({ vault: false });
    const connection = (await (await fetch(`${ui}/api/device/agent/connection`)).json()).connection as { url: string; token: string };
    const refused = (await openEvents(connection.url)).response;
    expect(refused.status).toBe(401);
    expect(refused.headers.get('XR-Revision'), 'a refused request learns no revision').toBeNull();
    const refusedWrite = await fetch(`${connection.url}/api/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect([refusedWrite.status, refusedWrite.headers.get('XR-Revision')]).toEqual([401, null]);
    const agent = await openEvents(connection.url, { authorization: `Bearer ${connection.token}` });
    expect(agent.response.status).toBe(200);
    await agent.next((event) => event.event === 'hello', 'agent hello');

    const rebound = await new Promise<{ status: number; revision: unknown }>((resolve, reject) => {
      const request = httpRequest(`${ui}/api/events`, { headers: { host: `rebound.example:${runtime.server.port}` } }, (response) => {
        resolve({ status: response.statusCode ?? 0, revision: response.headers['xr-revision'] ?? null });
        response.resume();
      });
      request.on('error', reject);
      request.end();
    });
    expect(rebound).toEqual({ status: 403, revision: null });

    const setup = await fetch(`${ui}/api/vault/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', location: outside, name: 'new-vault' }),
    });
    expect(setup.status).toBe(200);
    await agent.change((change) => change.kind === 'vault' && change.scope === 'contents', 'vault set up');
    agent.close();
  });
});

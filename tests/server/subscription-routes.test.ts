import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CollectorError } from '../../src/core/types.js';
import { Collector } from '../../src/core/collector.js';
import { registerSourceDefinitions } from '../../src/core/source-registry.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { PacingGate } from '../../src/pacing/pacing-gate.js';
import { YOUTUBE_PACING, youtubePlugin } from '../../src/plugins/youtube/server.js';
import { DEFAULT_POLICY } from '../../src/plugins/youtube/settings.js';
import { createHttpApp, type ConnectivityAccess } from '../../src/server/app.js';
import { CollectionScheduler, type ScheduleStore, type StoredSchedule } from '../../src/subscriptions/scheduler.js';
import { SubscriptionService, SubscriptionServices } from '../../src/subscriptions/subscription-service.js';
import { forwardingPort } from '../../src/jobs/subscription-port.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { createFakePlugin, FAKE, FAKE_DEFAULTS, FakeSource } from '../support/fake-source-plugin.js';
import { SyntheticYouTube } from '../subscriptions/synthetic-youtube.js';

// The subscription and collection routes every source type shares (B-T1 to B-T3): one Vault holds
// YouTube (synthetic channels) and the fake test type, and each route runs once per type through
// the UI listener and an Agent listener with a token.

registerSourceDefinitions([FAKE]);

const TOKEN = 'routes-token';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

class MemoryScheduleStore implements ScheduleStore {
  private value: StoredSchedule = { enabled: true };
  async load(): Promise<StoredSchedule> { return { ...this.value }; }
  async save(value: StoredSchedule): Promise<void> { this.value = { ...value }; }
}

/** How a test reaches one source type: its addresses, its targets and the values its routes answer with. */
interface TypeCase {
  type: 'youtube' | 'fake';
  kindLabel: string;
  itemKind: string;
  addKind: string;
  defaults: Record<string, string | number>;
  /** A settings patch the type accepts and one it refuses. */
  patch: Record<string, string | number>;
  badPatch: Record<string, unknown>;
  /** Adds a target with one recent item; returns the subscription ID, the address to subscribe with and the item's address. */
  addTarget(name: string): { id: string; url: string; itemUrl: string };
}

async function world(connectivity?: ConnectivityAccess) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-subscription-routes-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const youtube = new SyntheticYouTube();
  const fake = new FakeSource('fake');
  const setTimer = () => () => undefined;
  const gates = [
    await PacingGate.open(YOUTUBE_PACING, { now, setTimer, statePath: null }),
    await PacingGate.open(FAKE.pacing!, { now, setTimer, statePath: null }),
  ];
  const plugins = [youtubePlugin(youtube), createFakePlugin(FAKE, fake, gates[1])];
  const collector = new Collector(new MarkdownVault(root, { now }));
  const stores = { youtube: new JsonSubscriptionStore(root, 'youtube', now), fake: new JsonSubscriptionStore(root, 'fake', now) };
  const jobs: JobManager = new JobManager({
    vaultPath: root, store: JobStore.memory(now), plugins, documents: collector, subscriptions: forwardingPort(() => new SubscriptionServices(services)), now,
    pacing: gates, limits: { discovery: 1, capture: 2 }, retry: { maxAttempts: 1 },
  });
  let scheduler!: CollectionScheduler;
  const service = (type: 'youtube' | 'fake') => new SubscriptionService(type, stores[type], jobs, {
    autoCollection: () => scheduler.isEnabled(),
    resolveTarget: (url, signal) => plugins.find((plugin) => plugin.id === type)!.resolveTarget!(url, { priority: 'interactive', signal }),
    documents: () => collector.list(),
    deleteDocument: (id) => collector.delete(id),
    now,
  });
  const services = [service('youtube'), service('fake')];
  scheduler = new CollectionScheduler(services, new MemoryScheduleStore(), { now, pollIntervalMs: 24 * 60 * 60_000 });
  const options = { collector, jobs, subscriptions: services, schedule: scheduler, pacing: gates, ...(connectivity ? { connectivity } : {}) };
  const ui = await createHttpApp(options);
  const agent = await createHttpApp({ ...options, agentToken: TOKEN });
  const send = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, app: FastifyInstance = agent) => {
    const response = await app.inject({
      method, url, headers: app === agent ? { authorization: `Bearer ${TOKEN}` } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: response.statusCode, body: response.json() };
  };
  const settled = async (id: string) => {
    await vi.waitFor(async () => expect((await send('GET', `/api/jobs/${id}`)).body.job.state).toMatch(/^(completed|failed)$/u));
    return (await send('GET', `/api/jobs/${id}`)).body.job;
  };
  /** Subscribes over HTTP and waits for the first check. */
  const subscribe = async (url: string) => {
    const added = await settled((await send('POST', '/api/subscriptions', { url })).body.job.id);
    await settled(added.result.followUpJobId);
    return added;
  };
  const cases: TypeCase[] = [
    {
      type: 'youtube', kindLabel: 'YouTube 頻道', itemKind: 'youtube.video', addKind: 'youtube.channel-add',
      defaults: { ...DEFAULT_POLICY }, patch: { backfillDays: 45 }, badPatch: { backfillDays: 61 },
      addTarget(name) {
        const id = youtube.addChannel(name);
        const [video] = youtube.publish(id, name.slice(0, 1), clock.now, [1]);
        return { id, url: `https://www.youtube.com/@${name}`, itemUrl: `https://www.youtube.com/watch?v=${video}` };
      },
    },
    {
      type: 'fake', kindLabel: 'fake 動態', itemKind: 'fake.item', addKind: 'fake.feed-add',
      defaults: { ...FAKE_DEFAULTS }, patch: { maxItems: 3 }, badPatch: { maxItems: 0 },
      addTarget(name) {
        const [key] = fake.addFeed(name, clock.now, [1]);
        return { id: name, url: `https://fake.example/feed/${name}`, itemUrl: `https://fake.example/item/${key}` };
      },
    },
  ];
  const close = async () => {
    await vi.waitFor(() => expect(jobs.isBusy()).toBe(false));
    await ui.close();
    await agent.close();
    await jobs.close();
  };
  return { root, clock, ui, agent, scheduler, send, settled, subscribe, cases, close, fake, youtube };
}

const caseOf = (type: 'youtube' | 'fake') => (w: Awaited<ReturnType<typeof world>>) => w.cases.find((entry) => entry.type === type)!;

describe.each(['youtube', 'fake'] as const)('subscription and collection routes for %s (B-T1)', (type) => {
  it('accepts an address by its type at /api/submissions and /api/items', async () => {
    const w = await world();
    const c = caseOf(type)(w);
    const target = c.addTarget('alpha');

    const item = await w.send('POST', '/api/submissions', { url: target.itemUrl });
    expect(item).toMatchObject({ status: 202, body: { deduplicated: false, job: { kind: c.itemKind, source: { type } } } });
    expect(item.body.job).not.toHaveProperty('checkpoint');
    expect(await w.settled(item.body.job.id)).toMatchObject({ state: 'completed', result: { outcome: 'created' } });

    const added = await w.send('POST', '/api/submissions', { url: target.url });
    expect(added).toMatchObject({ status: 202, body: { job: { kind: c.addKind, source: { type } } } });
    const settled = await w.settled(added.body.job.id);
    expect(settled.result).toMatchObject({ outcome: 'created', subscriptionId: target.id, followUpJobId: expect.any(String) });
    expect(settled.result).not.toHaveProperty('channelId');
    expect((await w.send('GET', '/api/jobs?state=all&limit=10')).body.jobs.find((job: { id: string }) => job.id === settled.id).result)
      .toEqual(settled.result);

    const single = await w.send('POST', '/api/items', { url: target.itemUrl });
    expect(single).toMatchObject({ status: 202, body: { job: { kind: c.itemKind } } });
    expect((await w.send('POST', '/api/items', { url: target.url })).status).toBe(400);

    for (const route of ['/api/submissions', '/api/items']) {
      expect(await w.send('POST', route, {})).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
      expect(await w.send('POST', route, { url: 'ftp://elsewhere.example/page' })).toMatchObject({ status: 400, body: { error: { code: 'unsupported_url' } } });
      expect(await w.send('POST', route, { url: 'not an address' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_url' } } });
    }
    await w.close();
  });

  it('previews, subscribes, lists and reads a subscription by type and ID', async () => {
    const w = await world();
    const c = caseOf(type)(w);
    const target = c.addTarget('beta');

    const preview = await w.send('POST', '/api/subscription-previews', { url: target.url });
    expect(preview).toEqual({
      status: 200,
      body: { preview: { type, target: { id: target.id, title: expect.any(String), url: expect.any(String) }, subscription: null, settings: c.defaults, autoCollection: true } },
    });
    expect(await w.send('POST', '/api/subscription-previews', { url: target.itemUrl })).toMatchObject({ status: 400, body: { error: { code: 'invalid_subscription' } } });
    expect(await w.send('POST', '/api/subscription-previews', {})).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });

    expect(await w.send('POST', '/api/subscriptions', { url: target.url, settings: c.badPatch })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.send('POST', '/api/subscriptions', { url: target.itemUrl })).toMatchObject({ status: 400, body: { error: { code: 'invalid_subscription' } } });
    const accepted = await w.send('POST', '/api/subscriptions', { url: preview.body.preview.target.url, settings: c.patch });
    expect(accepted).toMatchObject({ status: 202, body: { job: { kind: c.addKind } } });
    const added = await w.settled(accepted.body.job.id);
    await w.settled(added.result.followUpJobId);
    expect((await w.send('POST', '/api/subscription-previews', { url: target.url })).body.preview)
      .toMatchObject({ type, subscription: { enabled: true, settings: { ...c.defaults, ...c.patch } } });

    const all = (await w.send('GET', '/api/subscriptions')).body;
    expect(Object.keys(all).sort()).toEqual(['pending', 'subscriptions', 'types', 'unsubscribed']);
    expect(all.subscriptions).toEqual([expect.objectContaining({ id: target.id, type, kindLabel: c.kindLabel, settings: { ...c.defaults, ...c.patch } })]);
    const ofType = (await w.send('GET', `/api/subscriptions?type=${type}`)).body;
    expect(ofType.subscriptions).toEqual(all.subscriptions);
    expect(ofType.types).toEqual([{ type, count: 1 }]);
    const other = type === 'youtube' ? 'fake' : 'youtube';
    expect((await w.send('GET', `/api/subscriptions?type=${other}`)).body).toMatchObject({ subscriptions: [], types: [{ type: other, count: 0 }] });
    expect(await w.send('GET', '/api/subscriptions?type=rss')).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.send('GET', '/api/subscriptions?channel=x')).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });

    const detail = await w.send('GET', `/api/subscriptions/${type}/${encodeURIComponent(target.id)}`);
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body).sort()).toEqual(['collection', 'subscription']);
    expect(detail.body.subscription).toMatchObject({ id: target.id, type, documentCount: 1 });
    expect(detail.body.collection.map((entry: { kind: string }) => entry.kind)).toEqual(['check', 'collected']);
    expect(detail.body.collection[0]).toMatchObject({ trigger: 'subscribe', created: 1, failed: 0, error: null });
    expect(await w.send('GET', `/api/subscriptions/${type}/missing`)).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });
    expect(await w.send('GET', `/api/subscriptions/rss/${encodeURIComponent(target.id)}`)).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });
    await w.close();
  });

  it('changes, pauses, resumes, applies, checks and removes a subscription', async () => {
    const w = await world();
    const c = caseOf(type)(w);
    const first = c.addTarget('gamma');
    const second = c.addTarget('delta');
    await w.subscribe(first.url);
    await w.subscribe(second.url);
    const route = (id: string) => `/api/subscriptions/${type}/${encodeURIComponent(id)}`;

    expect(await w.send('PATCH', route(first.id), { settings: c.patch })).toMatchObject({
      status: 200, body: { subscription: { id: first.id, settings: { ...c.defaults, ...c.patch } }, submission: null },
    });
    expect(await w.send('PATCH', route(first.id), { settings: c.badPatch })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.send('PATCH', route(first.id), { color: 'red' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.send('PATCH', route('missing'), { enabled: false })).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });
    expect(await w.send('PATCH', `/api/subscriptions/rss/${first.id}`, { enabled: false })).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });

    expect(await w.send('POST', `${route(first.id)}/apply-settings`)).toEqual({ status: 200, body: { updated: 1, paused: 0 } });
    expect(await w.send('POST', `${route('missing')}/apply-settings`)).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });

    expect(await w.send('PATCH', route(second.id), { enabled: false })).toMatchObject({ status: 200, body: { subscription: { enabled: false, settings: { ...c.defaults, ...c.patch } }, submission: null } });
    const paused = await w.send('POST', '/api/subscription-checks', { subscriptions: [{ type, id: first.id }, { type, id: second.id }] });
    expect(paused).toMatchObject({ status: 409, body: { error: { code: 'subscription_paused' } } });
    expect(await w.send('POST', '/api/subscription-checks', { subscriptions: [{ type, id: 'missing' }] })).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });
    expect(await w.send('POST', '/api/subscription-checks', { subscriptions: [{ type: 'rss', id: first.id }] })).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });
    for (const body of [{ subscriptions: [] }, { subscriptions: [first.id] }, { subscriptions: [{ type, id: first.id, extra: 1 }] }, { ids: [first.id] }]) {
      expect(await w.send('POST', '/api/subscription-checks', body)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    }

    const checked = await w.send('POST', '/api/subscription-checks', { subscriptions: [{ type, id: first.id }] });
    expect(checked).toMatchObject({ status: 202, body: { submissions: [{ job: { source: { type, id: first.id }, scope: { trigger: 'manual' } } }] } });
    expect(checked.body.submissions[0].job).not.toHaveProperty('checkpoint');
    await w.settled(checked.body.submissions[0].job.id);

    const resumed = await w.send('PATCH', route(second.id), { enabled: true });
    expect(resumed).toMatchObject({ status: 200, body: { subscription: { enabled: true }, submission: { job: { scope: { trigger: 'resume' } } } } });
    await w.settled(resumed.body.submission.job.id);

    const everything = await w.send('POST', '/api/subscription-checks');
    expect(everything.status).toBe(202);
    expect(everything.body.submissions.map((submission: { job: { source: { id: string } } }) => submission.job.source.id).sort()).toEqual([first.id, second.id].sort());
    await Promise.all(everything.body.submissions.map((submission: { job: { id: string } }) => w.settled(submission.job.id)));

    expect(await w.send('DELETE', `${route(first.id)}?documents=all`)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.send('DELETE', route(first.id))).toEqual({ status: 200, body: { removed: true, documentsKept: 1, documentsDeleted: 0, documentsFailed: 0 } });
    expect(await w.send('DELETE', route(first.id))).toMatchObject({ status: 404, body: { error: { code: 'subscription_not_found' } } });
    expect(await w.send('DELETE', `${route(second.id)}?documents=delete`)).toEqual({ status: 200, body: { removed: true, documentsKept: 0, documentsDeleted: 1, documentsFailed: 0 } });
    expect((await w.send('GET', `/api/subscriptions?type=${type}`)).body.subscriptions).toEqual([]);
    await w.close();
  });

  it('reports the schedule and pacing groups and offers recognition actions on the shared routes', async () => {
    const w = await world();
    const c = caseOf(type)(w);
    const target = c.addTarget('epsilon');
    const paused = c.addTarget('zeta');

    const unsubscribed = (await w.send('POST', '/api/url-recognitions', { url: target.url })).body.recognition;
    expect(unsubscribed.actions).toEqual([expect.objectContaining({ id: 'subscribe', request: { method: 'POST', path: '/api/subscriptions', body: { url: expect.any(String) } } })]);
    const item = (await w.send('POST', '/api/url-recognitions', { url: target.itemUrl })).body.recognition;
    expect(item.actions).toEqual([expect.objectContaining({ id: 'collect', request: { method: 'POST', path: '/api/items', body: { url: expect.any(String) } } })]);
    // The offered requests work as given.
    const performed = await w.send(unsubscribed.actions[0].request.method, unsubscribed.actions[0].request.path, unsubscribed.actions[0].request.body);
    expect(performed.status).toBe(202);
    await w.settled((await w.settled(performed.body.job.id)).result.followUpJobId);
    expect((await w.send(item.actions[0].request.method, item.actions[0].request.path, item.actions[0].request.body)).status).toBe(202);

    await w.subscribe(paused.url);
    await w.send('PATCH', `/api/subscriptions/${type}/${encodeURIComponent(paused.id)}`, { enabled: false });
    const resume = (await w.send('POST', '/api/url-recognitions', { url: paused.url })).body.recognition;
    expect(resume.actions).toEqual([expect.objectContaining({
      id: 'resume', request: { method: 'PATCH', path: `/api/subscriptions/${type}/${encodeURIComponent(paused.id)}`, body: { enabled: true } },
    })]);
    const resumed = await w.send(resume.actions[0].request.method, resume.actions[0].request.path, resume.actions[0].request.body);
    expect(resumed).toMatchObject({ status: 200, body: { subscription: { enabled: true } } });
    await w.settled(resumed.body.submission.job.id);

    const schedule = (await w.send('GET', '/api/schedule')).body.schedule;
    expect(schedule).toMatchObject({ enabled: true, status: 'scheduled' });
    expect(Object.keys(schedule.lastCheck).sort()).toEqual(['at', 'subscriptionId', 'title', 'type']);
    expect(schedule.lastCheck).toMatchObject({ type });
    expect(Object.keys(schedule.nextCheck).sort()).toEqual(['at', 'subscriptionId', 'title', 'type']);
    expect(await w.send('PUT', '/api/schedule', { enabled: false })).toMatchObject({ status: 200, body: { schedule: { enabled: false, status: 'paused', nextCheck: null } } });
    expect(await w.send('PUT', '/api/schedule', { enabled: 'no' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });

    const pacing = (await w.send('GET', '/api/pacing')).body;
    expect(pacing.groups.map((group: { group: string; label: string }) => [group.group, group.label])).toEqual([['youtube', 'YouTube'], ['fake-net', FAKE.pacing!.label]]);
    expect(pacing.groups[0]).toMatchObject({ state: expect.any(String), cooldownUntil: null, level: 0, waitRangeMs: { min: expect.any(Number), max: expect.any(Number) } });
    await w.close();
  });
});

describe('routes of the type-specific API (B-T2)', () => {
  it('answers 404 not_found on every route the shared routes stand for, to the UI and to an Agent', async () => {
    const w = await world();
    const youtube = w.cases[0]!.addTarget('legacy');
    await w.subscribe(youtube.url);
    const retired: Array<['GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['POST', '/api/youtube/submissions', { url: youtube.itemUrl }],
      ['POST', '/api/youtube/collect', { url: youtube.itemUrl }],
      ['POST', '/api/youtube/channel-previews', { url: youtube.url }],
      ['GET', '/api/youtube/channels'],
      ['POST', '/api/youtube/channels', { url: youtube.url }],
      ['PATCH', `/api/youtube/channels/${youtube.id}`, { enabled: false }],
      ['DELETE', `/api/youtube/channels/${youtube.id}`],
      ['POST', `/api/youtube/channels/${youtube.id}/apply-settings`],
      ['POST', '/api/youtube/channel-runs', { channelIds: [youtube.id] }],
      ['GET', '/api/youtube/schedule'],
      ['PUT', '/api/youtube/schedule', { enabled: false }],
      ['GET', '/api/youtube/pacing'],
      ['GET', '/api/fake/channels'],
      ['POST', '/api/fake/submissions', { url: 'https://fake.example/item/x' }],
      ['GET', '/api/sources'],
      ['GET', `/api/sources/youtube/${youtube.id}`],
    ];
    for (const app of [w.ui, w.agent]) {
      for (const [method, url, payload] of retired) {
        expect(await w.send(method, url, payload, app), `${method} ${url}`).toEqual({ status: 404, body: { error: { code: 'not_found', message: expect.any(String) } } });
      }
    }
    // Nothing a retired route was sent changed the subscription.
    expect((await w.send('GET', '/api/subscriptions')).body.subscriptions).toEqual([expect.objectContaining({ id: youtube.id, enabled: true })]);
    expect((await w.send('GET', '/api/schedule')).body.schedule.enabled).toBe(true);
    await w.close();
  });
});

describe('the jobs page routes (N69-T9)', () => {
  it('answers the overview and removes a failed item from it, the same for UI and Agents', async () => {
    const w = await world();
    w.fake.fail('broken-1', new CollectorError('video_unavailable', '文章不存在。'));
    const failed = await w.settled((await w.send('POST', '/api/items', { url: 'https://fake.example/item/broken-1' })).body.job.id);
    expect(failed).toMatchObject({ state: 'failed' });
    const [fromUi, fromAgent] = [await w.send('GET', '/api/jobs/overview', undefined, w.ui), await w.send('GET', '/api/jobs/overview')];
    expect(fromAgent).toEqual(fromUi);
    expect(fromAgent).toMatchObject({ status: 200, body: { overview: { running: [], queued: [], failed: [{
      jobId: failed.id, type: 'fake', role: 'item', title: null, url: 'https://fake.example/item/broken-1', publisher: null, progress: null,
      status: null, error: { code: 'video_unavailable' }, failedAt: failed.finishedAt,
    }] } } });
    expect(Object.keys(fromAgent.body.overview.failed[0]).sort()).toEqual(
      ['error', 'failedAt', 'jobId', 'progress', 'publisher', 'role', 'status', 'title', 'type', 'url'],
    );
    const skill = await readFile(path.resolve('skills/xr-collector-agent/SKILL.md'), 'utf8');
    for (const field of Object.keys(fromAgent.body.overview.failed[0])) expect(skill, field).toContain(`\`${field}\``);

    const dismissed = await w.send('POST', `/api/jobs/${failed.id}/dismiss`);
    expect(dismissed).toMatchObject({ status: 200, body: { job: { id: failed.id, dismissedAt: expect.any(String) } } });
    expect((await w.send('GET', '/api/jobs/overview', undefined, w.ui)).body.overview.failed).toEqual([]);
    expect(await w.send('POST', `/api/jobs/${failed.id}/dismiss`)).toMatchObject({ status: 409, body: { error: { code: 'job_not_dismissable' } } });
    expect(await w.send('POST', '/api/jobs/missing/dismiss')).toMatchObject({ status: 404, body: { error: { code: 'job_not_found' } } });
    expect((await w.agent.inject({ method: 'GET', url: '/api/jobs/overview' })).statusCode).toBe(401);
    await w.close();
  });
});

describe('the shared routes for UI and Agents (B-T3)', () => {
  it('answers the Agent token with what the UI reads, and the Skill names the fields the routes return', async () => {
    const w = await world();
    const skill = await readFile(path.resolve('skills/xr-collector-agent/SKILL.md'), 'utf8');
    const sharedIds = new Map<string, string>();
    for (const c of w.cases) {
      const target = c.addTarget('shared');
      sharedIds.set(c.type, target.id);
      // The Agent writes, the UI reads the result.
      await w.subscribe(target.url);
      expect((await w.send('PATCH', `/api/subscriptions/${c.type}/${encodeURIComponent(target.id)}`, { settings: c.patch })).status).toBe(200);
    }
    const reads = ['/api/subscriptions', '/api/subscriptions?type=fake', `/api/subscriptions/youtube/${encodeURIComponent(sharedIds.get('youtube')!)}`,
      `/api/subscriptions/fake/${encodeURIComponent(sharedIds.get('fake')!)}`, '/api/schedule', '/api/pacing', '/api/jobs?state=all'];
    for (const url of reads) {
      const [fromUi, fromAgent] = [await w.send('GET', url, undefined, w.ui), await w.send('GET', url)];
      expect(fromAgent.status, url).toBe(200);
      expect(fromAgent, url).toEqual(fromUi);
    }
    expect((await w.send('GET', '/api/subscriptions')).body.subscriptions.map((entry: { type: string; settings: unknown }) => [entry.type, entry.settings])).toEqual([
      ['youtube', { ...w.cases[0]!.defaults, ...w.cases[0]!.patch }], ['fake', { ...w.cases[1]!.defaults, ...w.cases[1]!.patch }],
    ]);
    expect((await w.send('GET', '/api/subscriptions', undefined, w.ui)).status).toBe(200);
    expect((await w.agent.inject({ method: 'GET', url: '/api/subscriptions' })).statusCode).toBe(401);

    // Every field the routes return is one the Skill names.
    const list = (await w.send('GET', '/api/subscriptions')).body;
    const detail = (await w.send('GET', '/api/subscriptions/fake/shared')).body;
    const preview = (await w.send('POST', '/api/subscription-previews', { url: 'https://fake.example/feed/shared' })).body.preview;
    const schedule = (await w.send('GET', '/api/schedule')).body.schedule;
    const pacing = (await w.send('GET', '/api/pacing')).body;
    const patched = (await w.send('PATCH', '/api/subscriptions/fake/shared', { enabled: false })).body;
    const checks = (await w.send('POST', '/api/subscription-checks', { subscriptions: [{ type: 'youtube', id: list.subscriptions[0].id }] })).body;
    const fields = new Set([
      ...Object.keys(list), ...Object.keys(list.subscriptions[0]), ...Object.keys(detail), ...detail.collection.flatMap((entry: object) => Object.keys(entry)),
      ...Object.keys(preview), ...Object.keys(preview.target), ...Object.keys(schedule), ...Object.keys(schedule.lastCheck),
      ...Object.keys(pacing), ...Object.keys(pacing.groups[0]), ...Object.keys(patched), ...Object.keys(checks),
    ]);
    const unnamed = [...fields].filter((field) => !skill.includes(`\`${field}\``));
    // Subscription rows also carry the stored record's own fields, which the Skill explains by meaning.
    expect(unnamed.filter((field) => !['title', 'url', 'id', 'addedAt', 'updatedAt'].includes(field))).toEqual([]);
    await vi.waitFor(async () => expect((await w.send('GET', '/api/jobs?state=active')).body.jobs).toEqual([]));
    await w.close();
  });
});

describe('requests the server cannot read', () => {
  it('answers 400 invalid_request to an empty or unparsable JSON body, and 500 only to a server error', async () => {
    const w = await world();
    const routes = [['POST', '/api/subscription-checks'], ['POST', '/api/subscriptions'], ['PUT', '/api/schedule']] as const;
    const answer = async (method: 'POST' | 'PUT', url: string, payload: string) => {
      const response = await w.agent.inject({
        method, url, payload, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      });
      return [response.statusCode, response.json().error];
    };
    for (const [method, url] of routes) {
      expect(await answer(method, url, '')).toEqual([400, { code: 'invalid_request', message: '請求宣告為 JSON，但內容是空的。' }]);
      expect(await answer(method, url, '{"enabled":')).toEqual([400, { code: 'invalid_request', message: '請求內容不是有效的 JSON。' }]);
    }
    vi.spyOn(w.scheduler, 'runNow').mockRejectedValueOnce(new Error('disk failure'));
    expect(await answer('POST', '/api/subscription-checks', '{}')).toEqual([500, { code: 'internal_error', message: '發生未預期的錯誤。' }]);
    await w.close();
  });
});

/** A device network the test switches; checking it answers the switch and is counted. */
function switchableNetwork() {
  const network = {
    state: 'online' as 'online' | 'offline',
    reachable: true,
    checks: 0,
    checkedAt: null as string | null,
    status: () => ({ state: network.state, checkedAt: network.checkedAt }),
    check: async () => {
      network.checks += 1;
      network.checkedAt = '2026-10-15T04:05:00.000Z';
      network.state = network.reachable ? 'online' : 'offline';
      return network.state;
    },
    confirm: () => network.check(),
  };
  return network;
}

describe('a preview while its source cools down', () => {
  it('answers rate_limited at once, to the UI and to an Agent, without asking the source', async () => {
    const w = await world();
    const c = caseOf('fake')(w);
    const target = c.addTarget('cooling');
    const resolve = vi.spyOn(w.fake, 'resolve');
    resolve.mockRejectedValueOnce(new CollectorError('rate_limited', '暫時限制連線。'));
    expect(await w.send('POST', '/api/subscription-previews', { url: target.url }))
      .toMatchObject({ status: 503, body: { error: { code: 'rate_limited' } } });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await w.send('GET', '/api/pacing')).body.groups.find((group: { group: string }) => group.group === FAKE.pacing!.group))
      .toMatchObject({ state: 'cooldown' });

    for (const app of [w.agent, w.ui]) {
      expect(await w.send('POST', '/api/subscription-previews', { url: target.url }, app))
        .toMatchObject({ status: 503, body: { error: { code: 'rate_limited' } } });
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    await w.close();
  });
});

describe('without a network (#128)', () => {
  it('refuses work that needs the network with offline, and starts no job', async () => {
    const network = switchableNetwork();
    const w = await world(network);
    const c = caseOf('youtube')(w);
    const kept = c.addTarget('kept');
    await w.subscribe(kept.url);
    const broken = c.addTarget('broken');
    w.youtube.failures.set(new URL(broken.itemUrl).searchParams.get('v')!, new CollectorError('video_unavailable', '影片不存在。'));
    const failed = await w.settled((await w.send('POST', '/api/items', { url: broken.itemUrl })).body.job.id);
    expect(failed).toMatchObject({ state: 'failed' });
    const fresh = c.addTarget('new');
    const jobCount = async () => (await w.send('GET', '/api/jobs?state=all&limit=100')).body.jobs.length;
    const before = await jobCount();

    network.state = 'offline';
    network.reachable = false;
    network.checkedAt = '2026-10-15T04:01:00.000Z';
    const refused = [
      ['/api/submissions', { url: fresh.itemUrl }],
      ['/api/items', { url: fresh.itemUrl }],
      ['/api/subscriptions', { url: fresh.url }],
      ['/api/subscription-previews', { url: fresh.url }],
      ['/api/url-recognitions', { url: fresh.url }],
      [`/api/jobs/${failed.id}/retry`, undefined],
    ] as const;
    for (const [route, body] of refused) {
      for (const app of [w.agent, w.ui]) {
        expect({ route, ...(await w.send('POST', route, body, app)) }).toEqual({
          route, status: 503, body: { error: { code: 'offline', message: '目前沒有網路，恢復後再試。' } },
        });
      }
    }
    expect(network.checks).toBe(0);
    expect(await jobCount()).toBe(before);

    // Checking subscriptions confirms the network first and is refused only while it is still gone.
    expect(await w.send('POST', '/api/subscription-checks')).toMatchObject({ status: 503, body: { error: { code: 'offline' } } });
    expect(await w.send('POST', '/api/subscription-checks', { subscriptions: [{ type: 'youtube', id: kept.id }] }))
      .toMatchObject({ status: 503, body: { error: { code: 'offline' } } });
    expect(network.checks).toBe(2);
    expect(await jobCount()).toBe(before);

    network.reachable = true;
    expect(await w.send('POST', '/api/subscription-checks')).toMatchObject({ status: 202, body: { submissions: [{ job: { kind: 'youtube.channel' } }] } });
    expect(network.checks).toBe(3);
    expect((await w.send('POST', '/api/items', { url: fresh.itemUrl })).status).toBe(202);
    await w.close();
  });

  it('confirms the network when a preview cannot reach the source, and answers offline when it is gone', async () => {
    const network = switchableNetwork();
    const w = await world(network);
    const c = caseOf('youtube')(w);
    const target = c.addTarget('preview');
    const resolve = vi.spyOn(w.youtube, 'resolveChannel');
    resolve.mockRejectedValueOnce(new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。'));
    network.reachable = false;
    expect(await w.send('POST', '/api/subscription-previews', { url: target.url }))
      .toMatchObject({ status: 503, body: { error: { code: 'offline', message: '目前沒有網路，恢復後再試。' } } });
    expect(network.status().state).toBe('offline');

    // With the network there, the failure is the source's own.
    network.state = 'online';
    network.reachable = true;
    resolve.mockRejectedValueOnce(new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。'));
    expect(await w.send('POST', '/api/subscription-previews', { url: target.url }))
      .toMatchObject({ status: 503, body: { error: { code: 'network_error' } } });
    expect(network.checks).toBe(2);
    await w.close();
  });

  it('reports the network in health and the schedule to the UI and Agents alike', async () => {
    const network = switchableNetwork();
    const w = await world(network);
    expect((await w.send('GET', '/api/health')).body.connectivity).toEqual({ state: 'online', checkedAt: null });
    network.state = 'offline';
    network.checkedAt = '2026-10-15T04:01:00.000Z';
    for (const app of [w.agent, w.ui]) {
      expect((await w.send('GET', '/api/health', undefined, app)).body.connectivity).toEqual({ state: 'offline', checkedAt: '2026-10-15T04:01:00.000Z' });
      expect((await w.send('GET', '/api/schedule', undefined, app)).body.schedule.connectivity).toEqual({ state: 'offline', checkedAt: '2026-10-15T04:01:00.000Z' });
    }
    expect((await w.send('PUT', '/api/schedule', { enabled: false })).body.schedule).toMatchObject({ enabled: false, connectivity: { state: 'offline' } });
    await w.close();
  });
});

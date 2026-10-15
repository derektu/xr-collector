import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelCollector, type SchedulePolicy } from '../../src/channels/channel-collector.js';
import { DEFAULT_POLICY } from '../../src/channels/collection-policy.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector } from '../../src/core/collector.js';
import { CollectorError, type SavedDocument } from '../../src/core/types.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { MemoryDocuments, SyntheticYouTube } from '../channels/synthetic-youtube.js';

const MINUTE = 60_000;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Real subscription and job services over synthetic channels, served by the HTTP app with an Agent token. */
async function world() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-sources-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const policy: SchedulePolicy = { enabled: true, ...DEFAULT_POLICY };
  const source = new SyntheticYouTube();
  const documents = new MemoryDocuments(now);
  const collector = new Collector(documents);
  const channelStore = new JsonChannelStore(root);
  const jobs = new JobManager({
    vaultPath: root, store: JobStore.memory(now), source, documents: collector, channels: channelStore, now,
    policy: async () => ({ ...policy }), limits: { discovery: 1, capture: 4 },
    // Failures here are about the subscription status; automatic retries have their own cases.
    retry: { maxAttempts: 1 },
  });
  const channels = new ChannelCollector(channelStore, jobs, {
    policy: async () => ({ ...policy }), resolveChannel: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
  });
  const app = await createHttpApp({ collector, jobs, channels, agentToken: 'agent-token' });
  const get = async (url: string) => {
    const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer agent-token' } });
    return { status: response.statusCode, body: response.json() };
  };
  const subscribe = async (name: string) => {
    const added = await jobs.whenSettled((await channels.addChannel(`@${name}`)).job.id);
    return jobs.whenSettled(added.result!.followUpJobId!);
  };
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { root, clock, source, documents, jobs, channels, app, get, subscribe, advance };
}

describe('source list (T-06, T-08)', () => {
  it('counts documents per subscription and gathers the rest into the single-item summary', async () => {
    const w = await world();
    const subscribed = w.source.addChannel('alpha');
    const other = w.source.addChannel('beta');
    const leaving = w.source.addChannel('gamma');
    w.source.publish(subscribed, 'a', w.clock.now, [1, 2]);
    const [betaVideo] = w.source.publish(other, 'b', w.clock.now, [1]);
    w.source.publish(leaving, 'g', w.clock.now, [1, 2, 3]);
    await w.subscribe('alpha');
    await w.subscribe('gamma');
    w.advance(10 * MINUTE);
    // A single video of an unsubscribed channel, and one of a subscribed channel published later.
    await w.jobs.whenSettled((await w.jobs.submitVideo(`https://youtu.be/${betaVideo}`)).job.id);
    const [lateAlpha] = w.source.publish(subscribed, 'n', w.clock.now, [0]);
    w.advance(5 * MINUTE);
    await w.jobs.whenSettled((await w.jobs.submitVideo(`https://youtu.be/${lateAlpha}`)).job.id);
    const unsubscribedAt = w.clock.now.toISOString();
    await w.channels.removeChannel(leaving);
    const legacy: SavedDocument = {
      id: 'youtube:legacy00001', type: 'Transcript', title: '舊文件', sourceUrl: 'https://www.youtube.com/watch?v=legacy00001',
      sourceType: 'youtube', sourceId: 'legacy00001', publisher: { id: null, name: '未知頻道' },
      publishedAt: null, collectedAt: '2026-01-01T00:00:00.000Z', bodyMarkdown: '舊字幕',
    };
    w.documents.documents.set('legacy00001', legacy);

    const { status, body } = await w.get('/api/sources');

    expect(status).toBe(200);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({
      type: 'youtube', kind: 'channel', kindLabel: 'YouTube 頻道', id: subscribed, title: '合成頻道 alpha',
      status: 'tracking', lastError: null, documentCount: 3, lastCollectedAt: unsubscribedAt,
    });
    // beta's single video, gamma's three kept documents and the legacy document without a publisher ID.
    expect(body.unsubscribed).toEqual({ documentCount: 5, lastCollectedAt: new Date(w.clock.now.getTime() - 5 * MINUTE).toISOString() });
    expect(body.types).toEqual([{ type: 'youtube', count: 1 }]);
    await w.app.close();
  });

  it('marks a subscription whose latest channel job failed and clears it after the next success', async () => {
    const w = await world();
    const id = w.source.addChannel('alpha');
    w.source.publish(id, 'a', w.clock.now, [1]);
    await w.subscribe('alpha');

    w.source.discoveryFailure = new CollectorError('network_error', '無法連線到 YouTube。');
    const [failed] = await w.channels.startRun({ trigger: 'manual' });
    await w.jobs.whenSettled(failed!.job.id);
    const broken = (await w.get('/api/sources')).body.sources[0];

    w.source.discoveryFailure = null;
    const [retried] = await w.channels.startRun({ trigger: 'manual' });
    await w.jobs.whenSettled(retried!.job.id);
    const recovered = (await w.get('/api/sources')).body.sources[0];

    expect(broken).toMatchObject({ status: 'error', lastError: { code: 'network_error', message: '無法連線到 YouTube。' } });
    expect(recovered).toMatchObject({ status: 'tracking', lastError: null });
    await w.app.close();
  });

  it('keeps the error through a later interrupted job, which says nothing about the source', async () => {
    const w = await world();
    const id = w.source.addChannel('alpha');
    await w.subscribe('alpha');
    w.source.discoveryFailure = new CollectorError('network_error', '無法連線到 YouTube。');
    const failed = await w.jobs.whenSettled((await w.channels.startRun({ trigger: 'manual' }))[0]!.job.id);
    // A newer channel job that a shutdown interrupted, as the job history reports it after a restart.
    const history = w.jobs.channelJobs.bind(w.jobs);
    vi.spyOn(w.jobs, 'channelJobs').mockImplementation(() => {
      const jobs = history();
      const interrupted = { ...failed, id: 'interrupted-run', state: 'interrupted' as const, error: { code: 'interrupted', message: '服務停止時工作尚未完成。' } };
      jobs.set(id, [interrupted, ...(jobs.get(id) ?? [])]);
      return jobs;
    });

    expect((await w.get('/api/sources')).body.sources[0]).toMatchObject({ status: 'error', lastError: { code: 'network_error' } });
    await w.app.close();
  });

  it('shows a paused subscription as paused even when its latest job failed', async () => {
    const w = await world();
    const id = w.source.addChannel('alpha');
    await w.subscribe('alpha');
    w.source.discoveryFailure = new CollectorError('network_error', '無法連線到 YouTube。');
    await w.jobs.whenSettled((await w.channels.startRun({ trigger: 'manual' }))[0]!.job.id);
    await w.channels.setChannelEnabled(id, false);

    expect((await w.get('/api/sources')).body.sources[0]).toMatchObject({ status: 'paused', lastError: null });
    await w.app.close();
  });

  it('reports an empty single-item summary when every document belongs to a subscription', async () => {
    const w = await world();
    const id = w.source.addChannel('alpha');
    w.source.publish(id, 'a', w.clock.now, [1]);
    await w.subscribe('alpha');

    expect((await w.get('/api/sources')).body.unsubscribed).toEqual({ documentCount: 0, lastCollectedAt: null });
    await w.app.close();
  });
});

describe('source detail (T-07, T-08)', () => {
  it('returns the newest five documents and this channel’s jobs, newest first', async () => {
    const w = await world();
    const id = w.source.addChannel('alpha');
    const other = w.source.addChannel('beta');
    w.source.publish(id, 'a', w.clock.now, [1, 2, 3, 4, 5, 6]);
    w.source.publish(other, 'b', w.clock.now, [1]);
    await w.subscribe('alpha');
    await w.subscribe('beta');
    w.advance(5 * MINUTE);
    const [fresh] = w.source.publish(id, 'n', w.clock.now, [0]);
    await w.jobs.whenSettled((await w.channels.startRun({ trigger: 'manual', channelIds: [id] }))[0]!.job.id);

    const { status, body } = await w.get(`/api/sources/youtube/${encodeURIComponent(id)}`);

    expect(status).toBe(200);
    expect(body.source).toMatchObject({ id, type: 'youtube', kindLabel: 'YouTube 頻道', documentCount: 7, status: 'tracking' });
    expect(body.recentDocuments).toHaveLength(5);
    expect(body.recentDocuments[0]).toMatchObject({ sourceId: fresh, collectedAt: w.clock.now.toISOString() });
    expect(body.recentDocuments.every((document: { publisher: { id: string } }) => document.publisher.id === id)).toBe(true);
    expect(body.recentJobs.map((job: { trigger: string }) => job.trigger)).toEqual(['manual', 'subscribe']);
    expect(body.recentJobs[0]).toMatchObject({ state: 'completed', outcome: 'created', progress: { created: 1 }, retry: null, resumedCount: 0 });
    expect(body.recentJobs[1]).toMatchObject({ state: 'completed', outcome: 'created', progress: { created: 6 } });
    await w.app.close();
  });

  it('answers 404 for an unknown source or source type', async () => {
    const w = await world();
    expect((await w.get('/api/sources/youtube/UCmissing')).status).toBe(404);
    expect((await w.get('/api/sources/rss/anything')).status).toBe(404);
    await w.app.close();
  });

  it('requires the Agent token like every business route', async () => {
    const w = await world();
    for (const request of [
      { method: 'GET' as const, url: '/api/sources' },
      { method: 'GET' as const, url: '/api/source-types' },
      { method: 'POST' as const, url: '/api/url-recognitions', payload: { url: '@alpha' } },
    ]) {
      expect((await w.app.inject(request)).statusCode).toBe(401);
    }
    w.source.addChannel('alpha');
    const recognized = await w.app.inject({
      method: 'POST', url: '/api/url-recognitions', payload: { url: '@alpha' }, headers: { authorization: 'Bearer agent-token' },
    });
    expect(recognized.json().recognition).toMatchObject({ status: 'ready', kind: 'channel', actions: [{ id: 'subscribe' }] });
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    await w.app.close();
  });
});

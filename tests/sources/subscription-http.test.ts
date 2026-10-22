import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionService, SubscriptionServices } from '../../src/subscriptions/subscription-service.js';
import { forwardingPort } from '../../src/jobs/subscription-port.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { Collector } from '../../src/core/collector.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { SyntheticYouTube } from '../subscriptions/synthetic-youtube.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import { youtubeKey } from '../support/youtube-documents.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))); });

/**
 * Real subscription, job and document services over synthetic channels and a Markdown Vault with
 * deletion records, served twice: to the UI without a token and to Agents with one.
 */
async function world(options: { removalSettleMs?: number; failDeleting?: (id: string) => boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-subscription-http-'));
  roots.push(root);
  const clock = { now: new Date('2026-10-15T04:00:00.000Z') };
  const now = () => clock.now;
  const source = new SyntheticYouTube();
  const store = JobStore.memory(now);
  const removedFromSearch: string[] = [];
  const search = { index: async () => undefined, remove: async (id: string) => { removedFromSearch.push(id); } };
  const collector: Collector = new Collector(new MarkdownVault(root, { now }), search, { recordEvent: (entry) => jobs.recordEvent(entry) });
  const channelStore = new JsonSubscriptionStore(root, 'youtube', now);
  const jobs: JobManager = new JobManager({
    vaultPath: root, store, plugins: [youtubePlugin(source)], documents: collector, subscriptions: forwardingPort(() => new SubscriptionServices([channels])), now,
    limits: { discovery: 1, capture: 4 }, retry: { maxAttempts: 1 },
  });
  const channels = new SubscriptionService('youtube', channelStore, jobs, {
    autoCollection: async () => true, resolveTarget: (url) => source.resolveChannel(url), documents: () => collector.list(), now,
    deleteDocument: async (id) => {
      if (options.failDeleting?.(id)) throw new Error('disk error');
      return collector.delete(id);
    },
    recordDeletion: (entry) => collector.recordDeletion(entry), removalSettleMs: options.removalSettleMs ?? 5_000,
  });
  const ui = await createHttpApp({ collector, jobs, subscriptions: [channels] });
  const agent = await createHttpApp({ collector, jobs, subscriptions: [channels], agentToken: 'agent-token' });
  const send = async (method: 'GET' | 'DELETE', url: string, app = agent) => {
    const response = await app.inject({ method, url, ...(app === agent ? { headers: { authorization: 'Bearer agent-token' } } : {}) });
    return { status: response.statusCode, body: response.json() };
  };
  const subscribe = async (name: string) => {
    const added = await jobs.whenSettled((await channels.add(`@${name}`)).job.id);
    return jobs.whenSettled(added.result!.followUpJobId!);
  };
  const events = async () => (await store.activity.query({ limit: 200 }, { vaultPath: root })).events;
  /** Resolves once a removal has written the deletion record of a video that is still capturing. */
  const deletionRecorded = (videoId: string) => vi.waitFor(async () => expect(await collector.isDeletedFor(youtubeKey(videoId), { explicitAt: null })).toBe(true));
  const close = async () => { await vi.waitFor(() => expect(jobs.isBusy()).toBe(false)); await ui.close(); await agent.close(); };
  return { root, clock, source, collector, jobs, channels, ui, agent, send, subscribe, events, removedFromSearch, deletionRecorded, close };
}

describe('subscription requests in the list (N75-T6)', () => {
  it('lists a subscription request at once and replaces it with the subscription', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha', '【合成】頻道 A');
    w.source.publish(alpha, 'a', w.clock.now, [1]);
    let release!: () => void;
    const resolving = new Promise<void>((resolve) => { release = resolve; });
    const resolve = w.source.resolveChannel.bind(w.source);
    vi.spyOn(w.source, 'resolveChannel').mockImplementation(async (url) => { await resolving; return resolve(url); });

    const accepted = await w.channels.add('@alpha');
    const pending = (await w.send('GET', '/api/subscriptions')).body;
    expect(pending.subscriptions).toEqual([]);
    expect(pending.pending).toEqual([{ type: 'youtube', jobId: accepted.job.id, url: accepted.job.source.url, title: null, checkStatus: expect.objectContaining({ state: expect.stringMatching(/^(queued|adding)$/u) }) }]);

    release();
    const added = await w.jobs.whenSettled(accepted.job.id);
    await w.jobs.whenSettled(added.result!.followUpJobId!);
    const listed = (await w.send('GET', '/api/subscriptions')).body;
    expect(listed.pending).toEqual([]);
    expect(listed.subscriptions.map((entry: { id: string }) => entry.id)).toEqual([alpha]);
    await w.close();
  });

  it('drops a subscription request whose channel cannot be resolved; the job keeps the reason', async () => {
    const w = await world();
    const accepted = await w.channels.add('@missing');
    const failed = await w.jobs.whenSettled(accepted.job.id);

    expect(failed).toMatchObject({ state: 'failed', error: { code: 'invalid_subscription' } });
    expect((await w.send('GET', '/api/subscriptions')).body).toMatchObject({ subscriptions: [], pending: [] });
    expect((await w.events()).some((event) => event.jobId === accepted.job.id && event.severity === 'error')).toBe(true);
    await w.close();
  });
});

describe('removed subscriptions in the document channel filter (N75-T7)', () => {
  it('marks a removed subscription, not a channel only added item by item or one still subscribed', async () => {
    const w = await world();
    const kept = w.source.addChannel('kept', '【合成】訂閱中');
    const leaving = w.source.addChannel('leaving', '【合成】要移除');
    const single = w.source.addChannel('single', '【合成】單支');
    w.source.publish(kept, 'k', w.clock.now, [1]);
    w.source.publish(leaving, 'l', w.clock.now, [1, 2]);
    const [video] = w.source.publish(single, 's', w.clock.now, [1]);
    await w.subscribe('kept');
    await w.subscribe('leaving');
    await w.jobs.whenSettled((await w.jobs.submitItem('youtube', `https://youtu.be/${video}`)).job.id);
    await w.channels.remove(leaving);

    const publishers = (await w.send('GET', '/api/documents/sources')).body.sources.groups[0].publishers;
    expect(publishers).toEqual(expect.arrayContaining([
      { id: kept, name: '【合成】訂閱中', count: 1, subscribed: true, removed: false },
      { id: leaving, name: '【合成】要移除', count: 2, subscribed: false, removed: true },
      { id: single, name: '【合成】單支', count: 1, subscribed: false, removed: false },
    ]));
    await w.close();
  });
});

describe('removing a subscription with its documents (N75-T8)', () => {
  it('deletes each document as a user deletion does, waits for a running capture and collects nothing later', async () => {
    const w = await world();
    const leaving = w.source.addChannel('leaving', '【合成】要移除');
    const other = w.source.addChannel('other', '【合成】其他');
    const videos = w.source.publish(leaving, 'l', w.clock.now, [1, 2, 3]);
    w.source.publish(other, 'o', w.clock.now, [1]);
    await w.subscribe('other');
    await w.subscribe('leaving');
    // A newer video is capturing when the subscription goes.
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const [late] = w.source.publish(leaving, 'n', w.clock.now, [0]);
    w.source.holdCaptures = true;
    const check = (await w.channels.startRun({ trigger: 'manual', subscriptionIds: [leaving] }))[0]!;
    await vi.waitFor(() => expect(w.source.running()).toEqual([late]));

    let answered = false;
    const removal = w.send('DELETE', `/api/subscriptions/youtube/${leaving}?documents=delete`).finally(() => { answered = true; });
    // The capturing video is marked deleted first, and the removal waits for the capture to end.
    await w.deletionRecorded(late!);
    expect(answered).toBe(false);
    w.source.release(late!);
    const removed = await removal;
    await w.jobs.whenSettled(check.job.id);

    // The capturing video got its deletion record first, so it was never saved; the saved ones were deleted.
    expect(removed).toEqual({ status: 200, body: { removed: true, documentsKept: 0, documentsDeleted: 3, documentsFailed: 0 } });
    expect((await w.jobs.whenSettled(check.job.id)).items?.find((item) => item.sourceId === late)?.skipReason).toBe('deleted');
    const saved = videos.map((id) => `youtube:${id}`).sort();
    expect((await w.collector.list()).map((document) => document.publisher.id)).toEqual([other]);
    const ledger = JSON.parse(await readFile(path.join(w.root, DELETIONS_FILE), 'utf8')) as { deleted: Array<{ sourceId: string }> };
    expect(ledger.deleted.map((record) => `youtube:${record.sourceId}`).sort()).toEqual([...saved, `youtube:${late}`].sort());
    expect([...w.removedFromSearch].sort()).toEqual(saved);
    const events = await w.events();
    expect(events.filter((event) => event.eventType === 'document.deleted').map((event) => event.documentId).sort()).toEqual(saved);
    expect(events.find((event) => event.eventType === 'subscription.removed')?.message).toBe('已移除「【合成】要移除」，並刪除 3 份文件。');

    // Later checks leave the channel alone, and its deleted videos stay deleted.
    expect(await w.channels.startRun({ trigger: 'scheduled' })).toHaveLength(1);
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect((await w.collector.list()).every((document) => document.publisher.id === other)).toBe(true);
    await w.close();
  });

  it('deletes the video a paused subscription is still capturing', async () => {
    const w = await world();
    const leaving = w.source.addChannel('leaving', '【合成】要移除');
    w.source.publish(leaving, 'l', w.clock.now, [1]);
    await w.subscribe('leaving');
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const [late] = w.source.publish(leaving, 'n', w.clock.now, [0]);
    w.source.holdCaptures = true;
    await w.channels.startRun({ trigger: 'manual', subscriptionIds: [leaving] });
    await vi.waitFor(() => expect(w.source.running()).toEqual([late]));
    await w.channels.setEnabled(leaving, false);
    expect((await w.send('GET', '/api/subscriptions?type=youtube')).body.subscriptions[0]).toMatchObject({ capturing: true, checkStatus: { state: 'paused' } });

    const removal = w.send('DELETE', `/api/subscriptions/youtube/${leaving}?documents=delete`);
    await w.deletionRecorded(late!);
    w.source.release(late!);
    expect((await removal).body).toEqual({ removed: true, documentsKept: 0, documentsDeleted: 1, documentsFailed: 0 });
    await vi.waitFor(() => expect(w.jobs.isBusy()).toBe(false));
    expect(await w.collector.list()).toEqual([]);
    const ledger = JSON.parse(await readFile(path.join(w.root, DELETIONS_FILE), 'utf8')) as { deleted: Array<{ sourceId: string }> };
    expect(ledger.deleted.map((record) => record.sourceId)).toContain(late);
    await w.close();
  });

  it('waits for a single-video request of the channel and deletes what it saved', async () => {
    const w = await world();
    const leaving = w.source.addChannel('leaving', '【合成】要移除');
    w.source.publish(leaving, 'l', w.clock.now, [1]);
    await w.subscribe('leaving');
    const [single] = w.source.publish(leaving, 's', w.clock.now, [0]);
    w.source.holdCaptures = true;
    const request = await w.jobs.submitItem('youtube', `https://youtu.be/${single}`);
    await vi.waitFor(() => expect(w.source.running()).toEqual([single]));

    // Whether the capture ends before or while the removal waits, its document is saved and then deleted.
    const removal = w.send('DELETE', `/api/subscriptions/youtube/${leaving}?documents=delete`);
    w.source.release(single!);
    expect((await removal).body).toEqual({ removed: true, documentsKept: 0, documentsDeleted: 2, documentsFailed: 0 });
    expect((await w.jobs.whenSettled(request.job.id)).state).toBe('completed');
    expect(await w.collector.list()).toEqual([]);
    await w.close();
  });

  it('keeps a capture that ends after the wait from saving, and deletes a late single-video document', async () => {
    const w = await world({ removalSettleMs: 30 });
    const leaving = w.source.addChannel('leaving', '【合成】要移除');
    w.source.publish(leaving, 'l', w.clock.now, [1]);
    await w.subscribe('leaving');
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const [late, single] = w.source.publish(leaving, 'n', w.clock.now, [0, 0]);
    w.source.holdCaptures = true;
    const check = (await w.channels.startRun({ trigger: 'manual', subscriptionIds: [leaving] }))[0]!;
    await vi.waitFor(() => expect(w.source.running()).toContain(late));
    const request = await w.jobs.submitItem('youtube', `https://youtu.be/${single}`);
    await vi.waitFor(() => expect(w.source.running()).toContain(single));

    // The removal answers after its bounded wait while both captures still run.
    const removed = await w.send('DELETE', `/api/subscriptions/youtube/${leaving}?documents=delete`);
    expect(removed.body).toEqual({ removed: true, documentsKept: 0, documentsDeleted: 1, documentsFailed: 0 });
    w.source.release(late!);
    w.source.release(single!);
    await w.jobs.whenSettled(check.job.id);
    await w.jobs.whenSettled(request.job.id);
    await vi.waitFor(async () => expect(await w.collector.list()).toEqual([]));
    const ledger = JSON.parse(await readFile(path.join(w.root, DELETIONS_FILE), 'utf8')) as { deleted: Array<{ sourceId: string }> };
    expect(ledger.deleted.map((record) => record.sourceId)).toEqual(expect.arrayContaining([late, single]));
    await w.close();
  });

  it('completes the removal and reports the documents it could not delete', async () => {
    const w = await world({ failDeleting: (id) => id.endsWith('2') });
    const leaving = w.source.addChannel('leaving', '【合成】要移除');
    const videos = w.source.publish(leaving, 'l', w.clock.now, [1, 2, 3]);
    await w.subscribe('leaving');
    const failing = videos.filter((id) => id.endsWith('2'));
    expect(failing).toHaveLength(1);

    const removed = await w.send('DELETE', `/api/subscriptions/youtube/${leaving}?documents=delete`);
    expect(removed).toEqual({ status: 200, body: { removed: true, documentsKept: 1, documentsDeleted: 2, documentsFailed: 1 } });
    expect((await w.collector.list()).map((document) => document.sourceId)).toEqual(failing);
    const event = (await w.events()).find((entry) => entry.eventType === 'subscription.removed');
    expect(event).toMatchObject({ severity: 'warning', message: '已移除「【合成】要移除」，刪除 2 份文件，1 份無法刪除。' });
    expect((await w.send('GET', '/api/subscriptions?type=youtube')).body.subscriptions).toEqual([]);
    await w.close();
  });

  it('keeps the documents by default and says so', async () => {
    const w = await world();
    const leaving = w.source.addChannel('leaving', '【合成】要移除');
    w.source.publish(leaving, 'l', w.clock.now, [1, 2]);
    await w.subscribe('leaving');

    expect(await w.send('DELETE', `/api/subscriptions/youtube/${leaving}`)).toEqual({ status: 200, body: { removed: true, documentsKept: 2, documentsDeleted: 0, documentsFailed: 0 } });
    expect(await w.collector.list()).toHaveLength(2);
    expect((await w.events()).find((event) => event.eventType === 'subscription.removed')?.message).toBe('已移除「【合成】要移除」，文件保留。');
    await w.close();
  });
});

describe('subscription status and removal over HTTP (N75-T9, N75-T10)', () => {
  it('reports the check status on every subscription route and checks the documents choice', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha', '【合成】頻道 A');
    await w.subscribe('alpha');
    const nextCheckAt = (await w.channels.list())[0]!.nextCheckAt;
    const expected = { state: 'scheduled', nextCheckAt };

    expect((await w.send('GET', '/api/subscriptions?type=youtube')).body.subscriptions[0].checkStatus).toEqual(expected);
    expect((await w.send('GET', '/api/subscriptions')).body.subscriptions[0].checkStatus).toEqual(expected);
    expect((await w.send('GET', `/api/subscriptions/youtube/${alpha}`)).body.subscription.checkStatus).toEqual(expected);

    for (const query of ['documents=remove', 'documents=', 'documents=keep&documents=delete']) {
      const rejected = await w.send('DELETE', `/api/subscriptions/youtube/${alpha}?${query}`);
      expect([rejected.status, rejected.body.error.code]).toEqual([400, 'invalid_request']);
    }
    expect((await w.channels.list()).map((channel) => channel.id)).toEqual([alpha]);
    expect((await w.send('DELETE', `/api/subscriptions/youtube/${alpha}?documents=keep`)).body).toEqual({ removed: true, documentsKept: 0, documentsDeleted: 0, documentsFailed: 0 });
    expect((await w.send('DELETE', `/api/subscriptions/youtube/${alpha}?documents=delete`)).status).toBe(404);
    await w.close();
  });

  it('answers the Agent with the same subscription fields the UI reads', async () => {
    const w = await world();
    const alpha = w.source.addChannel('alpha', '【合成】頻道 A');
    const beta = w.source.addChannel('beta', '【合成】頻道 B');
    w.source.publish(alpha, 'a', w.clock.now, [1]);
    await w.subscribe('alpha');
    await w.subscribe('beta');
    await w.channels.setEnabled(beta, false);
    await w.channels.remove(beta);
    await w.subscribe('beta');

    for (const route of ['/api/subscriptions', '/api/subscriptions?type=youtube', `/api/subscriptions/youtube/${alpha}`, '/api/documents/sources']) {
      const [fromUi, fromAgent] = [await w.send('GET', route, w.ui), await w.send('GET', route)];
      expect(fromAgent).toEqual(fromUi);
      expect(fromAgent.status).toBe(200);
    }
    const listed = (await w.send('GET', '/api/subscriptions')).body;
    expect(Object.keys(listed).sort()).toEqual(['pending', 'subscriptions', 'types', 'unsubscribed']);
    expect(listed.subscriptions[0]).toHaveProperty('checkStatus');
    await w.close();
  });
});

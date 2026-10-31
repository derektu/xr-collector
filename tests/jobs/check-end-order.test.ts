import { describe, expect, it } from 'vitest';
import { ChangeFeed, type ChangeBatch } from '../../src/core/change-feed.js';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { JobStore } from '../../src/jobs/job-store.js';
import type { CheckEnd } from '../../src/jobs/subscription-port.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import { SubscriptionRecorder } from '../support/subscription-recorder.js';

const VAULT = '/vaults/order';
const CHANNEL = { id: 'UCorder', title: '順序', url: 'https://www.youtube.com/channel/UCorder/videos' };

/** A subscription port whose first check-end write waits until the test releases it. */
class SlowEnd extends SubscriptionRecorder {
  release: () => void = () => undefined;
  entered: Promise<void>;
  private enter: () => void = () => undefined;
  private held = false;
  constructor(private readonly changes: ChangeFeed) {
    super();
    this.entered = new Promise((resolve) => { this.enter = resolve; });
  }

  override async checkEnded(type: string, id: string, end: CheckEnd): Promise<void> {
    if (!this.held) {
      this.held = true;
      this.enter();
      await new Promise<void>((resolve) => { this.release = resolve; });
    }
    await super.checkEnded(type, id, end);
    this.changes.note({ kind: 'subscription', type, id });
  }
}

const emptyVault: DocumentVault = {
  getByKey: async () => null,
  add: async () => { throw new Error('nothing is collected'); },
  list: async () => [],
  read: async () => null,
};

describe('a check ending', () => {
  it('reads as finished only once its subscription recorded the end', async () => {
    const changes = new ChangeFeed({ defer: () => undefined });
    const batches: ChangeBatch[] = [];
    changes.subscribe((batch) => batches.push(batch));
    const store = JobStore.memory(undefined, changes.note);
    const subs = new SlowEnd(changes);
    const manager = new JobManager({
      vaultPath: VAULT, store, subscriptions: subs, documents: new Collector(emptyVault),
      plugins: [youtubePlugin({
        resolveChannel: async () => CHANNEL, discover: async () => [], capture: async () => { throw new Error('no capture'); },
      })],
    });
    subs.attach(manager);
    const subscription = subs.add('youtube', CHANNEL);
    const submission = await manager.submitCheck('youtube', subscription, 'manual');
    const settled = manager.whenSettled(submission.job.id);

    await subs.entered;
    changes.flush();
    const waiting = { state: manager.get(submission.job.id).state, listed: store.list(VAULT)[0]?.state,
      ended: subs.of('ended').length, events: store.activity.query({ limit: 50 }, { vaultPath: null }) };
    expect(waiting).toMatchObject({ state: 'running', listed: 'running', ended: 0 });
    const again = await manager.submitCheck('youtube', subscription, 'manual');
    expect(again).toMatchObject({ deduplicated: true, job: { id: submission.job.id } });
    manager.stopSubscription('youtube', CHANNEL.id, 'subscription_paused');
    const resumed = await manager.submitCheck('youtube', subscription, 'resume');
    expect(resumed.deduplicated, 'a paused subscription frees its source for the resume check').toBe(false);
    expect(resumed.job.id).not.toBe(submission.job.id);
    expect((await waiting.events).events.map((event) => event.eventType)).not.toContain('job.completed');
    expect(batches.flatMap((batch) => batch.changes)).not.toContainEqual(expect.objectContaining({ kind: 'job', state: 'completed' }));

    subs.release();
    const job = await settled;
    changes.flush();
    expect(job.state).toBe('completed');
    expect(subs.of('ended')).toEqual([expect.objectContaining({ id: CHANNEL.id, at: job.finishedAt })]);
    const order = batches.flatMap((batch) => batch.changes);
    const recorded = order.findIndex((change) => change.kind === 'subscription' && change.id === CHANNEL.id);
    const finished = order.findIndex((change) => change.kind === 'job' && change.id === job.id && change.state === 'completed');
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(finished).toBeGreaterThan(recorded);
    expect((await store.activity.query({ limit: 50 }, { vaultPath: null })).events.map((event) => event.eventType)).toContain('job.completed');
    await manager.close();
  });
});

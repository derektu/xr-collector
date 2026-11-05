// A check reports to its subscription what happened, as it happened: a failed item and a failed
// check come with how the source type treats the failure, including a limit or a needed sign-in,
// so the subscriptions decide what counts against them.
import { describe, expect, it } from 'vitest';
import { Collector, type DocumentVault } from '../../src/core/collector.js';
import { CollectorError } from '../../src/core/collector-error.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { memoryJobRecords } from '../../src/runtime/job-records.js';
import { createFakePlugin, FAKE, FakeSource } from '../support/fake-source-plugin.js';
import { productSourcesWith } from '../support/product-sources.js';
import { SubscriptionRecorder } from '../support/subscription-recorder.js';

const SOURCES = productSourcesWith(FAKE);

function setup() {
  const source = new FakeSource('fake');
  const vault: DocumentVault = {
    sources: SOURCES,
    getByKey: async () => null,
    add: async () => { throw new Error('nothing is collected'); },
    list: async () => [],
    read: async () => null,
  };
  const subs = new SubscriptionRecorder(SOURCES);
  const manager = new JobManager({
    sources: SOURCES, vaultPath: '/vaults/reports', store: memoryJobRecords(SOURCES).jobs, subscriptions: subs,
    documents: new Collector(vault), plugins: [createFakePlugin(FAKE, source)], retry: { maxAttempts: 1 },
  });
  subs.attach(manager);
  return { source, subs, manager };
}

describe('a check', () => {
  it('reports an item that failed because the source needs a new sign-in, with its failure class', async () => {
    const { source, subs, manager } = setup();
    const [key] = source.addFeed('f', new Date(), [0]);
    source.fail(key!, new CollectorError('login_needed', '需要重新登入。'));
    const subscription = subs.add('fake', { id: 'f', title: 'f', url: 'https://fake.example/feed/f' });
    const check = await manager.whenSettled((await manager.submitCheck('fake', subscription, 'manual')).job.id);
    expect(check.state).toBe('completed');
    expect(subs.of('failed')).toEqual([expect.objectContaining({ id: 'f', key, errorCode: 'login_needed', failureClass: 'login_required' })]);
    await manager.close();
  });

  it('reports a check that failed because the source needs a new sign-in as a counted end with its failure class', async () => {
    const { source, subs, manager } = setup();
    source.addFeed('f', new Date(), [0]);
    source.listFailures.push(new CollectorError('login_needed', '需要重新登入。'));
    const subscription = subs.add('fake', { id: 'f', title: 'f', url: 'https://fake.example/feed/f' });
    const check = await manager.whenSettled((await manager.submitCheck('fake', subscription, 'manual')).job.id);
    expect(check).toMatchObject({ state: 'failed', error: { code: 'login_needed' } });
    expect(subs.of('ended')).toEqual([
      { kind: 'ended', type: 'fake', id: 'f', at: check.finishedAt, errorCode: 'login_needed', failureClass: 'login_required', counted: true },
    ]);
    await manager.close();
  });
});

// Broken, subscriptions count failures against themselves that they should not, or miss ones they should.
import { describe, expect, it } from 'vitest';
import { Collector } from '../../../src/domain/vault/collector.js';
import type { DocumentVault } from '../../../src/shared/documents/document-vault.js';
import { withoutDocumentChanges } from '../../support/document-vault-stubs.js';
import { CollectorError } from '../../../src/shared/lib/collector-error.js';
import { JobManager } from '../../../src/domain/jobs/job-manager.js';
import { memoryJobRecords } from '../../../src/app/runtime/job-records.js';
import { createFakePlugin, FAKE, FakeSource } from '../../support/fake-source-plugin.js';
import { productSourcesWith } from '../../support/product-sources.js';
import { SubscriptionRecorder } from '../../support/subscription-recorder.js';

const SOURCES = productSourcesWith(FAKE);

function setup() {
  const source = new FakeSource('fake');
  const vault: DocumentVault = {
    sources: SOURCES,
    getByKey: async () => null,
    add: async () => { throw new Error('nothing is collected'); },
    list: async () => [],
    read: async () => null,
    ...withoutDocumentChanges(),
  };
  const subs = new SubscriptionRecorder(SOURCES);
  const manager = new JobManager({
    sources: SOURCES, vaultPath: '/vaults/reports', vaultId: 'vault-id', store: memoryJobRecords(SOURCES).jobs, subscriptions: subs,
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

  it('does not report an item whose job record could not be written as a source failure, so the item is not skipped', async () => {
    const { source, subs, manager } = setup();
    const [key] = source.addFeed('f', new Date(), [0]);
    source.fail(key!, new CollectorError('jobs_write_failed', '無法寫入工作紀錄。'));
    const subscription = subs.add('fake', { id: 'f', title: 'f', url: 'https://fake.example/feed/f' });
    const check = await manager.whenSettled((await manager.submitCheck('fake', subscription, 'manual')).job.id);
    expect(check.items).toEqual([expect.objectContaining({ sourceId: key, state: 'failed' })]);
    expect(subs.of('failed')).toEqual([]);
    await manager.close();
  });

  it('ends uncounted when its own job record could not be written, so the subscription gains no consecutive failure', async () => {
    const { source, subs, manager } = setup();
    source.addFeed('f', new Date(), [0]);
    source.listFailures.push(new CollectorError('jobs_write_failed', '無法寫入工作紀錄。'));
    const subscription = subs.add('fake', { id: 'f', title: 'f', url: 'https://fake.example/feed/f' });
    const check = await manager.whenSettled((await manager.submitCheck('fake', subscription, 'manual')).job.id);
    expect(check).toMatchObject({ state: 'failed', error: { code: 'jobs_write_failed' } });
    expect(subs.of('ended')).toEqual([expect.objectContaining({ id: 'f', errorCode: 'jobs_write_failed', counted: false })]);
    await manager.close();
  });
});

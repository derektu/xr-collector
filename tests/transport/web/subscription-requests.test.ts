import { describe, expect, it } from 'vitest';
import type { JobView } from '../../../src/shared/jobs/job-types.js';
import { trackSubscriptionRequests } from '../../../src/transport/web/subscription-requests.js';

const isSubscription = (kind: string) => kind === 'subscribe';
const job = (id: string, state: JobView['state']) => ({ id, state }) as JobView;

function harness(states: Record<string, JobView['state']>) {
  const requests = trackSubscriptionRequests();
  const failed: string[] = [];
  const read = async (active: string[]) => {
    await requests.activeListRead(active.map((id) => ({ id })), async (id) => job(id, states[id] ?? 'completed'), (result) => failed.push(result.id));
  };
  return { requests, failed, read };
}

describe('subscription requests this window sent', () => {
  it('reports a failed subscription only for requests this window sent, once they leave the active list', async () => {
    const { requests, failed, read } = harness({ mine: 'failed', done: 'completed', refresh: 'failed' });
    requests.sent({ job: { id: 'mine', kind: 'subscribe' } }, isSubscription);
    requests.sent({ job: { id: 'done', kind: 'subscribe' } }, isSubscription);
    requests.sent({ job: { id: 'refresh', kind: 'collect' } }, isSubscription);

    await read(['mine', 'done', 'refresh']);
    expect(failed).toEqual([]);
    await read([]);
    expect(failed).toEqual(['mine']);
    await read([]);
    expect(failed).toEqual(['mine']);
  });

  it('keeps tracking a request that is still queued or running because the active list was read before it was accepted', async () => {
    const states: Record<string, JobView['state']> = { late: 'queued' };
    const { requests, failed, read } = harness(states);
    requests.sent({ job: { id: 'late', kind: 'subscribe' } }, isSubscription);

    await read([]);
    states.late = 'running';
    await read([]);
    expect(failed).toEqual([]);
    states.late = 'failed';
    await read([]);
    expect(failed).toEqual(['late']);
  });

  it('does not report subscription requests sent by Agents', async () => {
    const { failed, read } = harness({ agent: 'failed' });
    await read(['agent']);
    await read([]);
    expect(failed).toEqual([]);
  });
});

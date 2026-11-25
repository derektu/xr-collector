import { describe, expect, it } from 'vitest';
import { forwardingPort, type SubscriptionPort } from '../../../src/domain/jobs/index.js';

const unused = async (): Promise<never> => { throw new Error('not used by this test'); };

function portStopping(reason: 'subscription_paused' | 'subscription_removed'): SubscriptionPort {
  return {
    planCheck: unused, checked: unused, checkEnded: unused, itemCollected: unused, itemFailed: unused,
    itemOutOfRange: unused, subscribe: unused, checkNow: unused, stopped: async () => reason,
  };
}

describe('forwardingPort', () => {
  it('looks up the port at each call, so a job manager can be built before the subscriptions that hold it', async () => {
    let current: SubscriptionPort | undefined;
    const port = forwardingPort(() => {
      if (!current) throw new Error('subscriptions are not built yet');
      return current;
    });

    current = portStopping('subscription_paused');
    expect(await port.stopped('youtube', 'a')).toBe('subscription_paused');
    current = portStopping('subscription_removed');
    expect(await port.stopped('youtube', 'a')).toBe('subscription_removed');
  });
});

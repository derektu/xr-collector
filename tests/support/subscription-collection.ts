import type { SubscriptionCollection } from '../../src/server/routes/subscriptions.js';

function unused(name: string): () => never {
  return () => { throw new Error(`${name} is not used by this test`); };
}

/**
 * The subscriptions of `type` as the HTTP routes reach them: `methods` answers, and every other
 * required method fails the request that calls it. Optional methods stay absent unless given.
 */
export function subscriptionCollection(type: string, methods: Partial<Omit<SubscriptionCollection, 'type'>> = {}): SubscriptionCollection {
  return {
    type,
    list: unused('list'), listSubscriptions: unused('listSubscriptions'), preview: unused('preview'), add: unused('add'),
    setEnabled: unused('setEnabled'), updateSettings: unused('updateSettings'), applySettingsToAll: unused('applySettingsToAll'),
    remove: unused('remove'), checkable: unused('checkable'), startRun: unused('startRun'), checkJobs: unused('checkJobs'),
    ...methods,
  };
}

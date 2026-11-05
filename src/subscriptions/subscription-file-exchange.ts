import { subscriptionDefinitions } from '../core/source-registry.js';
import type { SubscriptionExchange, SubscriptionFileExchange } from '../core/subscription-exchange.js';
import type { SourceDefinition } from '../plugins/types.js';
import { importedSubscription, subscriptionContent } from './subscription-fields.js';
import { removalsFromJson, scheduleEnabledFromJson, subscriptionsFromJson, subscriptionsToJson } from './subscription-files.js';

/** The subscriptions file of one source type, as the Vault opens, exports and imports it. */
function fileExchange(definition: SourceDefinition): SubscriptionFileExchange {
  return {
    type: definition.id,
    file: definition.storage!.subscriptionsFile,
    read(value) {
      const removals = removalsFromJson(definition, value);
      return {
        subscriptions: subscriptionsFromJson(definition, value).map((row) => ({
          id: row.id, content: subscriptionContent(row), at: row.updatedAt ?? row.addedAt,
        })),
        removals: removals.map((record) => ({ id: record.id, at: record.removedAt })),
      };
    },
    take(local, incoming, ids) {
      const rows = new Map(subscriptionsFromJson(definition, local).map((row) => [row.id, row]));
      const removals = new Map(removalsFromJson(definition, local).map((record) => [record.id, record]));
      const theirRows = new Map(subscriptionsFromJson(definition, incoming).map((row) => [row.id, row]));
      const theirRemovals = new Map(removalsFromJson(definition, incoming).map((record) => [record.id, record]));
      for (const id of ids) {
        const row = theirRows.get(id);
        if (row) rows.set(id, importedSubscription(rows.get(id), row));
        else rows.delete(id);
        const removal = theirRemovals.get(id);
        if (removal) removals.set(id, removal);
        else removals.delete(id);
      }
      // The records go last, after the subscription list.
      const { removed: _removed, ...kept } = local && typeof local === 'object' && !Array.isArray(local) ? local as Record<string, unknown> : {};
      return subscriptionsToJson(definition, kept, [...rows.values()], [...removals.values()]);
    },
  };
}

/** The subscription and schedule files of the registered source types, for the Vault. */
export const subscriptionFileExchange: SubscriptionExchange = {
  files: () => subscriptionDefinitions().map(fileExchange),
  checkSchedule: (value) => { scheduleEnabledFromJson(value); },
};

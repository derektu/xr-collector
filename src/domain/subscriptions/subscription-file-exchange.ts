import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type { SubscriptionExchange, SubscriptionFileExchange } from '../../shared/subscriptions/subscription-exchange.js';
import type { SourceDefinition } from '../../shared/sources/source-contract.js';
import { importedSubscription, subscriptionContent } from './subscription-fields.js';
import { removalsFromJson, scheduleEnabledFromJson, subscriptionsFromJson, subscriptionsToJson } from './subscription-files.js';

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
      return subscriptionsToJson(definition, local, [...rows.values()], [...removals.values()]);
    },
  };
}

export function subscriptionFileExchange(registry: SourceRegistry): SubscriptionExchange {
  return {
    files: () => registry.subscriptionDefinitions.map(fileExchange),
    checkSchedule: (value) => { scheduleEnabledFromJson(value, registry.schedule.description); },
  };
}

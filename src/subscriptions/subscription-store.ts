import path from 'node:path';
import type { NoteChange } from '../core/change-feed.js';
import { readJsonFile, writeJsonFile } from '../core/json-file.js';
import { requireDefinition } from '../core/source-registry.js';
import type { SubscriptionRecord } from '../core/types.js';
import {
  removalsFromJson,
  subscriptionContent,
  subscriptionsFromJson,
  subscriptionsToJson,
  type SubscriptionFileSpec,
  type SubscriptionRemoval,
} from './subscription-files.js';
import { ensureVaultFormat } from '../vault/vault-directory.js';

export type SubscriptionPatch = Partial<Omit<SubscriptionRecord, 'id' | 'addedAt'>>;

/** The subscriptions of one source type in one Vault. */
export interface SubscriptionStore {
  list(): Promise<SubscriptionRecord[]>;
  /** Changes several subscriptions in one write; ids that no longer exist are left out of the result. */
  updateMany(patches: Map<string, SubscriptionPatch>): Promise<SubscriptionRecord[]>;
  /**
   * Changes subscriptions with patches computed from their current rows, in the same serialized
   * write as every other change, so a concurrent change is never computed from an older row.
   */
  updateWith(change: (subscriptions: readonly SubscriptionRecord[]) => Map<string, SubscriptionPatch>): Promise<SubscriptionRecord[]>;
  /** Subscribes a target, lifting its removal record; an existing subscription is returned as it is. */
  add(subscription: SubscriptionRecord): Promise<SubscriptionRecord>;
  /** Removes a subscription and records the removal with the store's clock; false when it does not exist. */
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<SubscriptionRecord | null>;
  /** Changes one subscription; returns null when it no longer exists, so a removed subscription is never recreated. */
  update(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | null>;
  /** The removal records; a store that keeps none leaves it out. */
  removals?(): Promise<SubscriptionRemoval[]>;
}

/**
 * The subscriptions of one source type in its Vault file, named by the type's storage declaration.
 * Each change reads and writes the whole file in one serialized step, so a subscription and its
 * removal record change together.
 */
export class JsonSubscriptionStore implements SubscriptionStore {
  private mutation: Promise<void> = Promise.resolve();
  private readonly spec: SubscriptionFileSpec;
  private readonly filePath: string;
  /** Whether this store has written the file once, with the Vault format its type needs in place. */
  private formatEnsured = false;

  /**
   * `type` names a registered source type with subscriptions; `now` stamps `updatedAt` and
   * `removedAt`; `noteChange` hears each subscription a write changed, once the file holds it.
   */
  constructor(private readonly root: string, readonly type: string, private readonly now: () => Date = () => new Date(),
    private readonly noteChange: NoteChange = () => undefined) {
    this.spec = requireDefinition(type);
    if (!this.spec.storage) throw new Error(`Source type ${type} has no subscriptions`);
    this.filePath = path.join(root, this.spec.storage.subscriptionsFile);
  }

  async list(): Promise<SubscriptionRecord[]> {
    await this.mutation;
    return this.readSubscriptions();
  }

  /** The removal records of the Vault. */
  async removals(): Promise<SubscriptionRemoval[]> {
    await this.mutation;
    return removalsFromJson(this.spec, await this.readFile());
  }

  add(subscription: SubscriptionRecord): Promise<SubscriptionRecord> {
    return this.mutate(async () => {
      const subscriptions = await this.readSubscriptions();
      const existing = subscriptions.find((candidate) => candidate.id === subscription.id);
      if (existing) return existing;
      const added = { ...subscription, updatedAt: subscription.updatedAt ?? subscription.addedAt };
      subscriptions.push(added);
      const removed = removalsFromJson(this.spec, await this.readFile()).filter((record) => record.id !== subscription.id);
      await this.write([added.id], subscriptions, removed);
      return added;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const subscriptions = await this.readSubscriptions();
      const subscription = subscriptions.find((candidate) => candidate.id === id);
      if (!subscription) return false;
      const removed = removalsFromJson(this.spec, await this.readFile()).filter((record) => record.id !== id);
      removed.push({ id, title: subscription.title, url: subscription.url, removedAt: this.now().toISOString() });
      await this.write([id], subscriptions.filter((candidate) => candidate.id !== id), removed);
      return true;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<SubscriptionRecord | null> {
    return this.update(id, { enabled });
  }

  update(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | null> {
    return this.mutate(async () => {
      const subscriptions = await this.readSubscriptions();
      const index = subscriptions.findIndex((subscription) => subscription.id === id);
      if (index < 0) return null;
      const current = subscriptions[index];
      if (!current) return null;
      const updated = this.stamped(current, { ...current, ...patch });
      subscriptions[index] = updated;
      await this.write([id], subscriptions);
      return updated;
    });
  }

  updateMany(patches: Map<string, SubscriptionPatch>): Promise<SubscriptionRecord[]> {
    return this.updateWith(() => patches);
  }

  updateWith(change: (subscriptions: readonly SubscriptionRecord[]) => Map<string, SubscriptionPatch>): Promise<SubscriptionRecord[]> {
    return this.mutate(async () => {
      const subscriptions = await this.readSubscriptions();
      const patches = change(subscriptions);
      const updated: SubscriptionRecord[] = [];
      const next = subscriptions.map((subscription) => {
        const patch = patches.get(subscription.id);
        if (!patch) return subscription;
        const changed = this.stamped(subscription, { ...subscription, ...patch });
        updated.push(changed);
        return changed;
      });
      if (updated.length > 0) await this.write(updated.map((subscription) => subscription.id), next);
      return updated;
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private readFile(): Promise<unknown> {
    return readJsonFile(this.filePath);
  }

  private async readSubscriptions(): Promise<SubscriptionRecord[]> {
    return subscriptionsFromJson(this.spec, await this.readFile()).sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  /**
   * Writes the subscriptions, and the removal records when given, keeping the other top-level fields
   * of the file, so a file written by a newer program keeps what this one does not define.
   */
  private async write(changed: readonly string[], subscriptions: SubscriptionRecord[], removed?: SubscriptionRemoval[]): Promise<void> {
    if (!this.formatEnsured) {
      await ensureVaultFormat(this.root, [this.type]);
      this.formatEnsured = true;
    }
    await writeJsonFile(this.filePath, subscriptionsToJson(this.spec, await this.readFile(), subscriptions, removed));
    for (const id of changed) this.noteChange({ kind: 'subscription', type: this.type, id });
  }

  /** A changed subscription, with `updatedAt` set to now when what the person sets on it differs. */
  private stamped(before: SubscriptionRecord, after: SubscriptionRecord): SubscriptionRecord {
    return subscriptionContent(before) === subscriptionContent(after) ? after : { ...after, updatedAt: this.now().toISOString() };
  }
}

import path from 'node:path';
import type { YouTubeChannel } from '../core/types.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { CHANNELS_FILE, channelsFromJson, removalsFromJson, subscriptionContent, type ChannelRemoval } from './subscription-files.js';

export type ChannelPatch = Partial<Omit<YouTubeChannel, 'id' | 'addedAt'>>;

export interface ChannelStore {
  list(): Promise<YouTubeChannel[]>;
  /** Changes several subscriptions in one write; ids that no longer exist are left out of the result. */
  updateMany(patches: Map<string, ChannelPatch>): Promise<YouTubeChannel[]>;
  /**
   * Changes subscriptions with patches computed from their current rows, in the same serialized
   * write as every other change, so a concurrent change is never computed from an older row.
   */
  updateWith(change: (channels: readonly YouTubeChannel[]) => Map<string, ChannelPatch>): Promise<YouTubeChannel[]>;
  /** Subscribes a channel, lifting its removal record; an existing subscription is returned as it is. */
  add(channel: YouTubeChannel): Promise<YouTubeChannel>;
  /** Removes a subscription and records the removal with the store's clock; false when it does not exist. */
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<YouTubeChannel | null>;
  /** Changes one subscription; returns null when it no longer exists, so a removed channel is never recreated. */
  update(id: string, patch: ChannelPatch): Promise<YouTubeChannel | null>;
  /** The removal records; a store that keeps none leaves it out. */
  removals?(): Promise<ChannelRemoval[]>;
}

/**
 * The subscriptions of one Vault in `settings/youtube-channels.json`. Each change reads and writes the
 * whole file in one serialized step, so a subscription and its removal record change together.
 */
export class JsonChannelStore implements ChannelStore {
  private mutation: Promise<void> = Promise.resolve();

  /** `now` stamps `updatedAt` and `removedAt`. */
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async list(): Promise<YouTubeChannel[]> {
    await this.mutation;
    return this.readChannels();
  }

  /** The removal records of the Vault. */
  async removals(): Promise<ChannelRemoval[]> {
    await this.mutation;
    return removalsFromJson(await this.readFile());
  }

  add(channel: YouTubeChannel): Promise<YouTubeChannel> {
    return this.mutate(async () => {
      const channels = await this.readChannels();
      const existing = channels.find((candidate) => candidate.id === channel.id);
      if (existing) return existing;
      const added = { ...channel, updatedAt: channel.updatedAt ?? channel.addedAt };
      channels.push(added);
      const removed = removalsFromJson(await this.readFile()).filter((record) => record.id !== channel.id);
      await this.writeChannels(channels, removed);
      return added;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const channels = await this.readChannels();
      const channel = channels.find((candidate) => candidate.id === id);
      if (!channel) return false;
      const removed = removalsFromJson(await this.readFile()).filter((record) => record.id !== id);
      removed.push({ id, title: channel.title, url: channel.url, removedAt: this.now().toISOString() });
      await this.writeChannels(channels.filter((candidate) => candidate.id !== id), removed);
      return true;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<YouTubeChannel | null> {
    return this.update(id, { enabled });
  }

  update(id: string, patch: ChannelPatch): Promise<YouTubeChannel | null> {
    return this.mutate(async () => {
      const channels = await this.readChannels();
      const index = channels.findIndex((channel) => channel.id === id);
      if (index < 0) return null;
      const current = channels[index];
      if (!current) return null;
      const updated = this.stamped(current, { ...current, ...patch });
      channels[index] = updated;
      await this.writeChannels(channels);
      return updated;
    });
  }

  updateMany(patches: Map<string, ChannelPatch>): Promise<YouTubeChannel[]> {
    return this.updateWith(() => patches);
  }

  updateWith(change: (channels: readonly YouTubeChannel[]) => Map<string, ChannelPatch>): Promise<YouTubeChannel[]> {
    return this.mutate(async () => {
      const channels = await this.readChannels();
      const patches = change(channels);
      const updated: YouTubeChannel[] = [];
      const next = channels.map((channel) => {
        const patch = patches.get(channel.id);
        if (!patch) return channel;
        const changed = this.stamped(channel, { ...channel, ...patch });
        updated.push(changed);
        return changed;
      });
      if (updated.length > 0) await this.writeChannels(next);
      return updated;
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private readFile(): Promise<unknown> {
    return readJsonFile(path.join(this.root, CHANNELS_FILE));
  }

  private async readChannels(): Promise<YouTubeChannel[]> {
    return channelsFromJson(await this.readFile()).sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  /**
   * Writes the subscriptions, and the removal records when given, keeping the other top-level fields
   * of the file, so a file written by a newer program keeps what this one does not define.
   */
  private async writeChannels(channels: YouTubeChannel[], removed?: ChannelRemoval[]): Promise<void> {
    const current = await this.readFile();
    const top = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
    const next: Record<string, unknown> = { ...top, version: 2, channels };
    if (removed !== undefined) {
      if (removed.length) next.removed = removed;
      else delete next.removed;
    }
    await writeJsonFile(path.join(this.root, CHANNELS_FILE), next);
  }

  /** A changed subscription, with `updatedAt` set to now when what the person sets on it differs. */
  private stamped(before: YouTubeChannel, after: YouTubeChannel): YouTubeChannel {
    return subscriptionContent(before) === subscriptionContent(after) ? after : { ...after, updatedAt: this.now().toISOString() };
  }
}

import path from 'node:path';
import type { YouTubeChannel } from '../core/types.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { CHANNELS_FILE, channelsFromJson, subscriptionContent, type ChannelsFile } from './subscription-files.js';

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
  add(channel: YouTubeChannel): Promise<YouTubeChannel>;
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<YouTubeChannel | null>;
  /** Changes one subscription; returns null when it no longer exists, so a removed channel is never recreated. */
  update(id: string, patch: ChannelPatch): Promise<YouTubeChannel | null>;
}

export class JsonChannelStore implements ChannelStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async list(): Promise<YouTubeChannel[]> {
    await this.mutation;
    return this.readChannels();
  }

  add(channel: YouTubeChannel): Promise<YouTubeChannel> {
    return this.mutate(async () => {
      const channels = await this.readChannels();
      const existing = channels.find((candidate) => candidate.id === channel.id);
      if (existing) return existing;
      const added = { ...channel, updatedAt: channel.updatedAt ?? channel.addedAt };
      channels.push(added);
      await this.writeChannels(channels);
      return added;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const channels = await this.readChannels();
      const remaining = channels.filter((channel) => channel.id !== id);
      if (remaining.length === channels.length) return false;
      await this.writeChannels(remaining);
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
      const updated = stamped(current, { ...current, ...patch });
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
        const changed = stamped(channel, { ...channel, ...patch });
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

  private async readChannels(): Promise<YouTubeChannel[]> {
    const value = await readJsonFile(path.join(this.root, CHANNELS_FILE));
    return channelsFromJson(value).sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  private async writeChannels(channels: YouTubeChannel[]): Promise<void> {
    const file: ChannelsFile = { version: 2, channels };
    await writeJsonFile(path.join(this.root, CHANNELS_FILE), file);
  }
}

/** A changed subscription, with `updatedAt` set to now when what the person sets on it differs. */
function stamped(before: YouTubeChannel, after: YouTubeChannel): YouTubeChannel {
  return subscriptionContent(before) === subscriptionContent(after) ? after : { ...after, updatedAt: new Date().toISOString() };
}

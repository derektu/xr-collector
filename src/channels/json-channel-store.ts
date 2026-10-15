import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChannelCursor, YouTubeChannel } from '../core/types.js';

export type ChannelPatch = Partial<Omit<YouTubeChannel, 'id' | 'addedAt'>>;

export interface ChannelStore {
  list(): Promise<YouTubeChannel[]>;
  add(channel: YouTubeChannel): Promise<YouTubeChannel>;
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<YouTubeChannel | null>;
  /** Changes one subscription; returns null when it no longer exists, so a removed channel is never recreated. */
  update(id: string, patch: ChannelPatch): Promise<YouTubeChannel | null>;
}

export class JsonChannelStore implements ChannelStore {
  private readonly filePath: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(vaultRoot: string) {
    this.filePath = path.join(vaultRoot, 'settings', 'youtube-channels.json');
  }

  async list(): Promise<YouTubeChannel[]> {
    await this.mutation;
    return this.readChannels();
  }

  add(channel: YouTubeChannel): Promise<YouTubeChannel> {
    return this.mutate(async () => {
      const channels = await this.readChannels();
      const existing = channels.find((candidate) => candidate.id === channel.id);
      if (existing) return existing;
      channels.push(channel);
      await this.writeChannels(channels);
      return channel;
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
      const updated = { ...current, ...patch };
      channels[index] = updated;
      await this.writeChannels(channels);
      return updated;
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readChannels(): Promise<YouTubeChannel[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(contents);
    if (!Array.isArray(parsed) || !parsed.every(isYouTubeChannel)) {
      throw new Error('Invalid YouTube channel settings');
    }
    return parsed.sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  private async writeChannels(channels: YouTubeChannel[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(channels, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    try {
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function isYouTubeChannel(value: unknown): value is YouTubeChannel {
  if (!value || typeof value !== 'object') return false;
  const channel = value as Partial<YouTubeChannel>;
  return typeof channel.id === 'string'
    && typeof channel.title === 'string'
    && typeof channel.url === 'string'
    && typeof channel.enabled === 'boolean'
    && typeof channel.addedAt === 'string'
    && (channel.cursor === undefined || channel.cursor === null || isCursor(channel.cursor))
    && (channel.lastCheckedAt === undefined || channel.lastCheckedAt === null || typeof channel.lastCheckedAt === 'string')
    && (channel.backlog === undefined || typeof channel.backlog === 'boolean');
}

function isCursor(value: unknown): value is ChannelCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<ChannelCursor>;
  return typeof cursor.videoId === 'string'
    && (cursor.publishedAt === null || typeof cursor.publishedAt === 'string')
    && Array.isArray(cursor.recentIds)
    && cursor.recentIds.every((id) => typeof id === 'string');
}

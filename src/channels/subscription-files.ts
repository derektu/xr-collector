import { isCollectionPolicy } from './collection-policy.js';
import type { YouTubeChannel } from '../core/types.js';

/**
 * Vault files of YouTube subscriptions, relative to the Vault root.
 *
 * `youtube-channels.json` is `{ version: 2, channels: [...], removed: [...] }`: every subscription
 * carries its own settings and check times, and every removed subscription leaves a record
 * `{ id, title, url, removedAt }` that stays until the channel is subscribed again, so an import
 * from another machine that still has the subscription does not bring it back. A file without
 * `removed` has no records. `youtube-schedule.json` is `{ version: 2, enabled }`, the automatic
 * collection switch. Fields a subscription or file does not define are kept as they are, so a file
 * written by a newer program, or one with fields no longer in use, reads and saves without losing them.
 * Files of any other version are not read.
 */
export const CHANNELS_FILE = 'settings/youtube-channels.json';
export const SCHEDULE_FILE = 'settings/youtube-schedule.json';

export interface ChannelsFile { version: 2; channels: YouTubeChannel[]; removed?: ChannelRemoval[] }

/** A removed subscription: when it was removed, and its name and address for people reading the record. */
export interface ChannelRemoval { id: string; title: string; url: string; removedAt: string }
export interface ScheduleFile { version: 2; enabled: boolean }

export class InvalidSubscriptionFile extends Error {}

/** The subscriptions of a channel file; a Vault without one has none. */
export function channelsFromJson(value: unknown): YouTubeChannel[] {
  if (value === undefined) return [];
  const file = value as Partial<ChannelsFile> | null;
  if (!file || typeof file !== 'object' || file.version !== 2 || !Array.isArray(file.channels) || !file.channels.every(isChannel)) {
    throw new InvalidSubscriptionFile('Invalid YouTube channel settings');
  }
  return file.channels;
}

/** The removal records of a channel file; a Vault without one, or a file without `removed`, has none. */
export function removalsFromJson(value: unknown): ChannelRemoval[] {
  channelsFromJson(value);
  const removed = (value as { removed?: unknown } | undefined)?.removed;
  if (removed === undefined) return [];
  if (!Array.isArray(removed) || !removed.every(isRemoval)) throw new InvalidSubscriptionFile('Invalid YouTube channel settings');
  return removed;
}

function isRemoval(value: unknown): value is ChannelRemoval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<ChannelRemoval>;
  return typeof record.id === 'string' && typeof record.title === 'string' && typeof record.url === 'string'
    && typeof record.removedAt === 'string' && !Number.isNaN(Date.parse(record.removedAt));
}

/** The automatic collection switch of a schedule file; a Vault without one collects automatically. */
export function scheduleEnabledFromJson(value: unknown): boolean {
  if (value === undefined) return true;
  const file = value as { version?: unknown; enabled?: unknown } | null;
  if (!file || typeof file !== 'object' || file.version !== 2 || typeof file.enabled !== 'boolean') {
    throw new InvalidSubscriptionFile('Invalid YouTube channel schedule settings');
  }
  return file.enabled;
}

function isSubscription(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const channel = value as Partial<YouTubeChannel>;
  return typeof channel.id === 'string'
    && typeof channel.title === 'string'
    && typeof channel.url === 'string'
    && typeof channel.enabled === 'boolean'
    && typeof channel.addedAt === 'string'
    && isOptionalTime(channel.updatedAt)
    && isOptionalTime(channel.lastCheckedAt);
}

function isChannel(value: unknown): value is YouTubeChannel {
  if (!isSubscription(value)) return false;
  const channel = value as Partial<YouTubeChannel>;
  return isCollectionPolicy(channel.settings) && isOptionalTime(channel.nextCheckAt) && isOptionalTime(channel.lastDispatchedAt)
    && (channel.outOfRange === undefined || (Array.isArray(channel.outOfRange)
      && channel.outOfRange.every((entry) => typeof entry?.videoId === 'string' && typeof entry.before === 'string')));
}

function isOptionalTime(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/** JSON with object keys in sorted order, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * What a person sets on a subscription: its title, URL, paused state and settings. Collection
 * progress, check times and fields the program does not use are left out, so they never count as a
 * change of the subscription.
 */
export function subscriptionContent({ title, url, enabled, settings }: YouTubeChannel): string {
  return canonicalJson({ title, url, enabled, settings });
}

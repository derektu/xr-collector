import path from 'node:path';
import { DEFAULT_POLICY, isBackfillLimit, isBackfillWindow, isCollectionPolicy, normalizeInterval } from './collection-policy.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import type { ChannelCursor, CollectionPolicy, YouTubeChannel } from '../core/types.js';

/**
 * Vault files of YouTube subscriptions, relative to the Vault root.
 *
 * `youtube-channels.json` version 2 is `{ version: 2, channels: [...] }`: every subscription carries
 * its own settings and check times. Version 1 is a bare array of subscriptions that share the
 * interval and backfill range of `youtube-schedule.json` version 1. `youtube-schedule.json`
 * version 2 holds only the automatic collection switch.
 *
 * A version 1 Vault is converted once, the first time it is opened: the shared settings are copied
 * to every subscription. Whether to convert depends only on the channel file's version, so a
 * converted Vault never reads the shared settings again.
 */
export const CHANNELS_FILE = 'settings/youtube-channels.json';
export const SCHEDULE_FILE = 'settings/youtube-schedule.json';

export interface ChannelsFile { version: 2; channels: YouTubeChannel[] }
export interface ScheduleFile { version: 2; enabled: boolean }

/** Version 1 schedule fields that the conversion reads; interval values before backfill settings existed may be any whole minute. */
interface LegacySchedule {
  enabled: boolean;
  intervalMinutes: number;
  backfillWindow?: unknown;
  backfillMaxItems?: unknown;
  lastAttemptAt?: string | null;
  nextRunAt?: string | null;
}

/** What a version 1 schedule file gives every subscription. */
interface SharedSettings extends CollectionPolicy {
  enabled: boolean;
  lastAttemptAt: string | null;
  nextRunAt: string | null;
}

type LegacyChannel = Omit<YouTubeChannel, 'settings' | 'nextCheckAt' | 'lastDispatchedAt'>;

export class InvalidSubscriptionFile extends Error {}

/** The subscriptions of a channel file of either version; a version 1 file takes the shared settings of `schedule`. */
export function channelsFromJson(value: unknown, schedule: unknown): YouTubeChannel[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (!value.every(isLegacyChannel)) throw new InvalidSubscriptionFile('Invalid YouTube channel settings');
    return value.map((channel) => convertChannel(channel, legacySchedule(schedule)));
  }
  const file = value as Partial<ChannelsFile> | null;
  if (!file || file.version !== 2 || !Array.isArray(file.channels) || !file.channels.every(isChannel)) {
    throw new InvalidSubscriptionFile('Invalid YouTube channel settings');
  }
  return file.channels;
}

/** The automatic collection switch of a schedule file of either version; a Vault without one collects automatically. */
export function scheduleEnabledFromJson(value: unknown): boolean {
  if (value === undefined) return true;
  const file = value as { version?: unknown; enabled?: unknown } | null;
  if (!file || (file.version !== 1 && file.version !== 2) || typeof file.enabled !== 'boolean') {
    throw new InvalidSubscriptionFile('Invalid YouTube channel schedule settings');
  }
  if (file.version === 1 && !legacySchedule(value)) throw new InvalidSubscriptionFile('Invalid YouTube channel schedule settings');
  return file.enabled;
}

/** Whether the channel file is version 1 and needs the conversion. */
export function isLegacyChannelsJson(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * Converts a version 1 Vault in place and reports whether it did. The channel file is written
 * first: a stop before the schedule file is rewritten leaves a version 2 channel file, which is
 * never converted again, and a version 1 schedule file, whose switch is still read.
 */
export async function migrateSubscriptionSettings(root: string): Promise<boolean> {
  const channelsPath = path.join(root, CHANNELS_FILE);
  const schedulePath = path.join(root, SCHEDULE_FILE);
  const [channels, schedule] = await Promise.all([readJsonFile(channelsPath), readJsonFile(schedulePath)]);
  let converted = false;
  if (isLegacyChannelsJson(channels)) {
    const file: ChannelsFile = { version: 2, channels: channelsFromJson(channels, schedule) };
    await writeJsonFile(channelsPath, file);
    converted = true;
  }
  if (schedule !== undefined && (schedule as { version?: unknown } | null)?.version !== 2) {
    const file: ScheduleFile = { version: 2, enabled: scheduleEnabledFromJson(schedule) };
    await writeJsonFile(schedulePath, file);
    converted = true;
  }
  return converted;
}

/**
 * The shared settings of a version 1 schedule file. Files written before the backfill settings
 * existed load with the default backfill and the nearest offered interval; a Vault without a
 * schedule file uses the defaults.
 */
function legacySchedule(value: unknown): SharedSettings | null {
  if (value === undefined) return { ...DEFAULT_POLICY, enabled: true, lastAttemptAt: null, nextRunAt: null };
  const schedule = value as Partial<LegacySchedule> | null;
  if (!schedule || typeof schedule.enabled !== 'boolean' || !Number.isInteger(schedule.intervalMinutes) || (schedule.intervalMinutes ?? 0) < 1) {
    return null;
  }
  return {
    enabled: schedule.enabled,
    intervalMinutes: normalizeInterval(schedule.intervalMinutes!),
    backfillWindow: isBackfillWindow(schedule.backfillWindow) ? schedule.backfillWindow : DEFAULT_POLICY.backfillWindow,
    backfillMaxItems: isBackfillLimit(schedule.backfillMaxItems) ? schedule.backfillMaxItems : DEFAULT_POLICY.backfillMaxItems,
    lastAttemptAt: typeof schedule.lastAttemptAt === 'string' ? schedule.lastAttemptAt : null,
    nextRunAt: typeof schedule.nextRunAt === 'string' ? schedule.nextRunAt : null,
  };
}

/**
 * A version 1 subscription with the shared settings. It keeps the shared check times, so the
 * conversion itself never makes every subscription due at once.
 */
function convertChannel(channel: LegacyChannel, schedule: ReturnType<typeof legacySchedule>): YouTubeChannel {
  if (!schedule) throw new InvalidSubscriptionFile('Invalid YouTube channel schedule settings');
  const { intervalMinutes, backfillWindow, backfillMaxItems } = schedule;
  return {
    ...channel,
    settings: { intervalMinutes, backfillWindow, backfillMaxItems },
    nextCheckAt: channel.enabled && schedule.enabled ? schedule.nextRunAt : null,
    lastDispatchedAt: schedule.lastAttemptAt,
  };
}

function isLegacyChannel(value: unknown): value is LegacyChannel {
  if (!value || typeof value !== 'object') return false;
  const channel = value as Partial<YouTubeChannel>;
  return typeof channel.id === 'string'
    && typeof channel.title === 'string'
    && typeof channel.url === 'string'
    && typeof channel.enabled === 'boolean'
    && typeof channel.addedAt === 'string'
    && (channel.cursor === undefined || channel.cursor === null || isCursor(channel.cursor))
    && isOptionalTime(channel.lastCheckedAt)
    && (channel.backlog === undefined || typeof channel.backlog === 'boolean');
}

function isChannel(value: unknown): value is YouTubeChannel {
  if (!isLegacyChannel(value)) return false;
  const channel = value as Partial<YouTubeChannel>;
  return isCollectionPolicy(channel.settings) && isOptionalTime(channel.nextCheckAt) && isOptionalTime(channel.lastDispatchedAt);
}

function isOptionalTime(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isCursor(value: unknown): value is ChannelCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<ChannelCursor>;
  return typeof cursor.videoId === 'string'
    && (cursor.publishedAt === null || typeof cursor.publishedAt === 'string')
    && Array.isArray(cursor.recentIds)
    && cursor.recentIds.every((id) => typeof id === 'string');
}

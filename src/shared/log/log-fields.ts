import type { LogLevel, LogSource } from './log-types.js';

const LOG_LEVELS = { debug: true, info: true, warn: true, error: true } satisfies Record<LogLevel, true>;

const LOG_SOURCES = {
  desktop: true, server: true, runtime: true, jobs: true, subscriptions: true, vault: true, search: true, pacing: true,
  activity: true, notifications: true, page: true,
} satisfies Record<LogSource, true>;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LOG_LEVELS, value);
}

export function isLogSource(value: unknown): value is LogSource {
  return typeof value === 'string' && Object.hasOwn(LOG_SOURCES, value);
}

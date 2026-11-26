/** How serious a log record is, from least to most. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The part of XR Collector a record comes from: `desktop` (the Electron shell), `server` (HTTP listeners and the
 * development server), `runtime` (service assembly, startup and shutdown), `jobs`, `subscriptions`, `vault`, `search`,
 * `pacing`, `activity` (the activity log itself), `notifications`, or `page` (the web UI, written through the UI
 * listener).
 */
export type LogSource =
  | 'desktop' | 'server' | 'runtime' | 'jobs' | 'subscriptions' | 'vault' | 'search' | 'pacing' | 'activity' | 'notifications' | 'page';

/**
 * One log record, as written one JSON object per line to `<profile>/logs/collector.jsonl`. `time` is an ISO 8601 UTC
 * timestamp; `stack` is the stack trace of the error the record reports, when it has one. Known secrets and credential
 * patterns are masked in `message` and `stack`.
 */
export interface LogRecord {
  time: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  stack?: string;
}

/**
 * What a writer hands to the log: a record without `time`, which the log adds. When `error` is given, the log appends
 * its message to `message` and takes its stack as `stack`, unless `stack` is given.
 */
export type LogInput = Omit<LogRecord, 'time'> & { error?: unknown };

/** Accepts log records. `write` returns at once and never throws; storing and printing happen behind it. */
export interface LogWriter {
  write(input: LogInput): void;
}

export interface LogQuery {
  level?: LogLevel[];
  /** Inclusive lower bound, ISO time. */
  since?: string;
  /** Exclusive upper bound, ISO time. */
  until?: string;
  limit: number;
  cursor?: string;
}

export interface LogPage {
  /** Newest first. */
  records: LogRecord[];
  nextCursor: string | null;
}

/** Reads the device log: the current file and the one previous generation. */
export interface LogReader {
  read(query: LogQuery): Promise<LogPage>;
}

/** What the web UI writes to the device log; the server records it with source `page`. */
export interface PageLogEntry {
  level: 'warn' | 'error';
  message: string;
  stack?: string;
}

import type { LogInput, LogPage, LogReader, LogWriter } from '../../src/shared/log/log-types.js';

/** A log that keeps what it is handed, for a test to check what the code under test wrote. Its `read` answers no records. */
export interface RecordingLog extends LogWriter, LogReader {
  readonly records: LogInput[];
}

export function recordingLog(): RecordingLog {
  const records: LogInput[] = [];
  const empty: LogPage = { records: [], nextCursor: null };
  return { records, write: (input) => { records.push(input); }, read: async () => empty };
}

/** Console output for a real log in a test, printing nothing. */
export const QUIET_OUTPUT = { log: () => undefined, warn: () => undefined, error: () => undefined };

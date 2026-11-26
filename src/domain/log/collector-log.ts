import { redact } from '../../shared/lib/redact.js';
import type { LogInput, LogLevel, LogPage, LogQuery, LogReader, LogRecord, LogWriter } from '../../shared/log/log-types.js';
import { LogFiles, MAX_LOG_FILE_BYTES } from './log-files.js';
import { readLog } from './log-reader.js';

export interface LogOutput {
  log(text: string): void;
  warn(text: string): void;
  error(text: string): void;
}

export interface CollectorLogOptions {
  folder: string;
  now?: () => Date;
  output?: LogOutput;
  maxFileBytes?: number;
}

export interface CollectorLog extends LogWriter, LogReader {
  flushed(): Promise<void>;
}

export function openCollectorLog(options: CollectorLogOptions): CollectorLog {
  const now = options.now ?? (() => new Date());
  const output = options.output ?? console;
  const files = new LogFiles(options.folder, options.maxFileBytes ?? MAX_LOG_FILE_BYTES, (error) => {
    output.error(`XR Collector could not write its log file in ${options.folder}: ${String(error)}. Records keep going to the console only.`);
  });
  return {
    write(input: LogInput) {
      const record = toRecord(input, now());
      mirror(output, record);
      files.append(JSON.stringify(record));
    },
    async read(query: LogQuery): Promise<LogPage> {
      await files.flushed();
      return readLog(options.folder, query);
    },
    flushed: () => files.flushed(),
  };
}

function toRecord(input: LogInput, time: Date): LogRecord {
  const { error, message, stack, level, source } = input;
  const fullMessage = error === undefined ? message : `${message}: ${error instanceof Error ? error.message : String(error)}`;
  const fullStack = stack ?? (error instanceof Error ? error.stack : undefined);
  return {
    time: time.toISOString(), level, source, message: redact(fullMessage),
    ...(fullStack === undefined ? {} : { stack: redact(fullStack) }),
  };
}

const OUTPUT_METHODS: Readonly<Record<LogLevel, keyof LogOutput>> = { debug: 'log', info: 'log', warn: 'warn', error: 'error' };

function mirror(output: LogOutput, record: LogRecord): void {
  const stack = record.stack === undefined ? '' : `\n${record.stack}`;
  output[OUTPUT_METHODS[record.level]](`${record.time} ${record.level} [${record.source}] ${record.message}${stack}`);
}

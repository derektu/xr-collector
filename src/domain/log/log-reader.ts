import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import { isLogLevel, isLogSource } from '../../shared/log/log-fields.js';
import type { LogPage, LogQuery, LogRecord } from '../../shared/log/log-types.js';
import { CURRENT_FILE, PREVIOUS_FILE } from './log-files.js';

export async function readLog(folder: string, query: LogQuery): Promise<LogPage> {
  const lines = [...await linesOf(path.join(folder, PREVIOUS_FILE)), ...await linesOf(path.join(folder, CURRENT_FILE))];
  const since = query.since === undefined ? null : Date.parse(query.since);
  const until = query.until === undefined ? null : Date.parse(query.until);
  const levels = query.level ? new Set(query.level) : null;
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const page: LogRecord[] = [];
  let sameTimeSeen = 0;
  let hasMore = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parsed(lines[index]!);
    if (!record) continue;
    const time = Date.parse(record.time);
    if (levels && !levels.has(record.level)) continue;
    if (since !== null && time < since) continue;
    if (until !== null && time >= until) continue;
    if (after) {
      if (time > after.time) continue;
      if (time === after.time && sameTimeSeen < after.skip) {
        sameTimeSeen += 1;
        continue;
      }
    }
    if (page.length === query.limit) {
      hasMore = true;
      break;
    }
    page.push(record);
  }
  const last = page.at(-1);
  return { records: page, nextCursor: hasMore && last ? encodeCursor(page, last, after) : null };
}

async function linesOf(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n');
  } catch {
    return [];
  }
}

function parsed(line: string): LogRecord | null {
  if (line.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const [time, level, source, message, stack]: unknown[] = ['time', 'level', 'source', 'message', 'stack'].map((key) => Reflect.get(value, key));
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time)) || !isLogLevel(level) || !isLogSource(source)
    || typeof message !== 'string' || (stack !== undefined && typeof stack !== 'string')) return null;
  return { time, level, source, message, ...(stack === undefined ? {} : { stack }) };
}

interface Cursor {
  time: number;
  skip: number;
}

function encodeCursor(page: readonly LogRecord[], last: LogRecord, previous: Cursor | null): string {
  const time = Date.parse(last.time);
  const onPage = page.filter((record) => Date.parse(record.time) === time).length;
  const skip = previous?.time === time ? previous.skip + onPage : onPage;
  return Buffer.from(JSON.stringify({ t: time, n: skip })).toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  const invalid = () => new CollectorError('invalid_request', 'log 的分頁位置無效，請重新讀取第一頁。');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof value !== 'object' || value === null || !('t' in value) || !('n' in value)) throw invalid();
  const { t, n } = value;
  if (typeof t !== 'number' || typeof n !== 'number' || !Number.isSafeInteger(t) || !Number.isSafeInteger(n) || n < 0) throw invalid();
  return { time: t, skip: n };
}

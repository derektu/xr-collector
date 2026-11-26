// Broken, the device log loses records, grows without bound, or hands Agents a page out of order.
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCollectorLog, type LogOutput } from '../../../src/domain/log/index.js';
import type { LogInput, LogRecord } from '../../../src/shared/log/log-types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-log-'));
  roots.push(root);
  return path.join(root, 'logs');
}

function recordingOutput(): LogOutput & { printed: Array<[keyof LogOutput, string]> } {
  const printed: Array<[keyof LogOutput, string]> = [];
  return {
    printed,
    log: (text) => { printed.push(['log', text]); },
    warn: (text) => { printed.push(['warn', text]); },
    error: (text) => { printed.push(['error', text]); },
  };
}

function ticking(start: string): () => Date {
  let next = Date.parse(start);
  return () => new Date((next += 1000) - 1000);
}

async function lines(file: string): Promise<unknown[]> {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

const info = (message: string): LogInput => ({ level: 'info', source: 'runtime', message });

describe('writing', () => {
  it('appends one JSON line per record with its time, level, source, message and the stack of its error, and prints it to the matching console stream', async () => {
    const logs = await folder();
    const output = recordingOutput();
    const log = openCollectorLog({ folder: logs, output, now: () => new Date('2026-11-26T01:00:00.000Z') });
    const error = new Error('disk full');
    log.write({ level: 'error', source: 'jobs', message: 'Collection jobs write failed', error });
    log.write({ level: 'warn', source: 'page', message: 'Unable to save theme preference', stack: 'at App' });
    log.write(info('ready'));
    await log.flushed();

    expect(await lines(path.join(logs, 'collector.jsonl'))).toEqual([
      { time: '2026-11-26T01:00:00.000Z', level: 'error', source: 'jobs', message: 'Collection jobs write failed: disk full', stack: error.stack },
      { time: '2026-11-26T01:00:00.000Z', level: 'warn', source: 'page', message: 'Unable to save theme preference', stack: 'at App' },
      { time: '2026-11-26T01:00:00.000Z', level: 'info', source: 'runtime', message: 'ready' },
    ]);
    expect(output.printed.map(([stream]) => stream)).toEqual(['error', 'warn', 'log']);
  });

  it('starts a new line after a line a crash left unfinished, so the next record stays readable', async () => {
    const logs = await folder();
    const first = openCollectorLog({ folder: logs, output: recordingOutput() });
    first.write(info('before'));
    await first.flushed();
    await appendFile(path.join(logs, 'collector.jsonl'), '{"time":"2026-11-');

    const second = openCollectorLog({ folder: logs, output: recordingOutput() });
    second.write(info('after'));
    const page = await second.read({ limit: 10 });
    expect(page.records.map((record) => record.message)).toEqual(['after', 'before']);
  });

  it('keeps printing every record and reports the first file failure once when the log folder cannot be written', async () => {
    const logs = await folder();
    await writeFile(logs, 'not a folder');
    const output = recordingOutput();
    const log = openCollectorLog({ folder: logs, output });
    log.write(info('one'));
    await log.flushed();
    log.write(info('two'));
    await log.flushed();

    const failures = output.printed.filter(([, text]) => text.includes('could not write its log file'));
    expect(failures).toHaveLength(1);
    expect(output.printed.filter(([, text]) => text.includes('[runtime]')).map(([, text]) => text.split(' ').at(-1))).toEqual(['one', 'two']);
  });
});

describe('rotation', () => {
  it('renames the file to collector.1.jsonl past the size limit, keeps only that one previous file, and reads across both newest first', async () => {
    const logs = await folder();
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ time: '2026-11-26T01:00:00.000Z', level: 'info', source: 'runtime', message: 'record 0' })}\n`);
    const log = openCollectorLog({ folder: logs, output: recordingOutput(), now: ticking('2026-11-26T01:00:00.000Z'), maxFileBytes: lineBytes * 2 });
    for (let index = 0; index < 5; index += 1) log.write(info(`record ${index}`));
    await log.flushed();

    const messages = async (file: string) => (await lines(path.join(logs, file))).map((record) => (record as LogRecord).message);
    expect(await messages('collector.jsonl')).toEqual(['record 4']);
    expect(await messages('collector.1.jsonl')).toEqual(['record 2', 'record 3']);
    expect((await log.read({ limit: 10 })).records.map((record) => record.message)).toEqual(['record 4', 'record 3', 'record 2']);
  });
});

describe('reading', () => {
  async function written(records: Array<{ at: string; level: LogRecord['level']; message: string }>) {
    const logs = await folder();
    let at = '';
    const log = openCollectorLog({ folder: logs, output: recordingOutput(), now: () => new Date(at) });
    for (const record of records) {
      at = record.at;
      log.write({ level: record.level, source: 'server', message: record.message });
    }
    await log.flushed();
    return { log, logs };
  }

  it('filters by any of the given levels and by since, inclusive, and until, exclusive', async () => {
    const { log } = await written([
      { at: '2026-11-26T01:00:00.000Z', level: 'error', message: 'a' },
      { at: '2026-11-26T02:00:00.000Z', level: 'info', message: 'b' },
      { at: '2026-11-26T03:00:00.000Z', level: 'warn', message: 'c' },
      { at: '2026-11-26T04:00:00.000Z', level: 'error', message: 'd' },
    ]);
    const messages = async (query: Parameters<typeof log.read>[0]) => (await log.read(query)).records.map((record) => record.message);
    expect(await messages({ limit: 10, level: ['warn', 'error'] })).toEqual(['d', 'c', 'a']);
    expect(await messages({ limit: 10, since: '2026-11-26T11:00:00+09:00', until: '2026-11-26T04:00:00Z' })).toEqual(['c', 'b']);
  });

  it('pages newest first with a cursor that stays put while records are added, also through records written in the same millisecond', async () => {
    const same = '2026-11-26T02:00:00.000Z';
    const { log, logs } = await written([
      { at: '2026-11-26T01:00:00.000Z', level: 'info', message: 'a' },
      { at: same, level: 'info', message: 'b' },
      { at: same, level: 'info', message: 'c' },
      { at: same, level: 'info', message: 'd' },
      { at: '2026-11-26T03:00:00.000Z', level: 'info', message: 'e' },
    ]);
    const first = await log.read({ limit: 2 });
    expect(first.records.map((record) => record.message)).toEqual(['e', 'd']);
    const writer = openCollectorLog({ folder: logs, output: recordingOutput(), now: () => new Date('2026-11-26T05:00:00.000Z') });
    writer.write(info('newer'));
    await writer.flushed();
    const second = await log.read({ limit: 2, cursor: first.nextCursor! });
    expect(second.records.map((record) => record.message)).toEqual(['c', 'b']);
    const third = await log.read({ limit: 2, cursor: second.nextCursor! });
    expect(third).toEqual({ records: [expect.objectContaining({ message: 'a' })], nextCursor: null });
  });

  it('skips lines that are not records and answers no records when there is no file yet', async () => {
    const { log, logs } = await written([{ at: '2026-11-26T01:00:00.000Z', level: 'info', message: 'kept' }]);
    await appendFile(path.join(logs, 'collector.jsonl'), 'not json\n{"time":"x","level":"info","source":"server","message":"bad time"}\n');
    expect((await log.read({ limit: 10 })).records.map((record) => record.message)).toEqual(['kept']);
    expect(await openCollectorLog({ folder: await folder(), output: recordingOutput() }).read({ limit: 10 })).toEqual({ records: [], nextCursor: null });
  });

  it('refuses a cursor it did not hand out', async () => {
    const { log } = await written([]);
    await expect(log.read({ limit: 10, cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

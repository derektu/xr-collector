import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Wall-clock timings for the stages of a packaging or release command.
 *
 * A stage is recorded when it settles, so the stage that throws is recorded as `failed` and a
 * report written from `finally` covers the run up to the failure. `group` gives nested work its
 * own timer: child stages share the parent's record list, carry the parent name as a prefix and
 * one more level of depth, and their time is also part of the parent's. Stages that run
 * concurrently (remote asset checks, electron-builder's ZIP and DMG) overlap in wall time.
 */
export function createStageTimer({ now = Date.now } = {}) {
  const origin = now();
  const stages = [];
  const scoped = (prefix, depth) => {
    const timer = {
      origin,
      stages,
      now,
      async time(name, work, details = {}) {
        const detail = { ...details };
        const startedAt = now();
        let status = 'failed';
        try {
          const result = await work(detail);
          status = 'ok';
          return result;
        } finally {
          stages.push(stageRecord(`${prefix}${name}`, depth, startedAt, now() - startedAt, status, detail));
        }
      },
      group(name, work, details = {}) {
        return timer.time(name, (detail) => work(scoped(`${prefix}${name} / `, depth + 1), detail), details);
      },
      record(name, { startedAt, ms, status = 'ok', depth: extraDepth = 0, ...details }) {
        stages.push(stageRecord(`${prefix}${name}`, depth + extraDepth, startedAt, ms, status, details));
      },
    };
    return timer;
  };
  return scoped('', 0);
}

/** Timer used when a caller passes none: work runs unchanged and nothing is recorded. */
export const noStageTimer = {
  origin: 0,
  stages: [],
  now: Date.now,
  time: (_name, work) => work({}),
  group: (_name, work) => work(noStageTimer, {}),
  record: () => undefined,
};

function stageRecord(name, depth, startedAt, ms, status, { count, bytes } = {}) {
  return { name, ms: Math.max(0, Math.round(ms)), status, depth, startedAt,
    ...(count === undefined ? {} : { count }), ...(bytes === undefined ? {} : { bytes }) };
}

/** Stages in start order, parents before the children that started with them. */
export function orderedStages(timer) {
  return [...timer.stages].sort((left, right) => left.startedAt - right.startedAt || left.depth - right.depth)
    .map(({ startedAt, ...stage }) => ({ ...stage, offsetMs: Math.max(0, startedAt - timer.origin) }));
}

export function formatTimingTable(stages, { totalMs, title = 'Stage timings' } = {}) {
  const rows = stages.map((stage) => [
    `${'  '.repeat(stage.depth)}${stage.name}`,
    formatDuration(stage.ms),
    stage.count === undefined ? '' : String(stage.count),
    stage.bytes === undefined ? '' : formatBytes(stage.bytes),
    stage.status,
  ]);
  if (totalMs !== undefined) rows.push(['Total (wall)', formatDuration(totalMs), '', '', '']);
  const header = ['Stage', 'Time', 'Count', 'Bytes', 'Status'];
  const widths = header.map((label, column) => Math.max(label.length, ...rows.map((row) => row[column].length)));
  const line = (row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ').trimEnd();
  return [
    `${title} (indented stages are part of the stage above; concurrent stages overlap)`,
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}

function formatDuration(ms) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function formatBytes(bytes) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KiB` : `${(bytes / 1024 / 1024).toFixed(1)}MiB`; }

/**
 * Runs `work`, then writes the timing JSON and prints the table whether `work` resolved or threw.
 * `describe` is called after `work` settles so it can report whatever identity the run had
 * reached. A failure to write the report is printed and never replaces the work's own result.
 */
export async function runWithTimingReport(timer, describe, work, { log = (text) => process.stderr.write(`${text}\n`) } = {}) {
  let failure = null;
  try {
    return await work();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await emitTimingReport(timer, describe(), failure, log);
  }
}

async function emitTimingReport(timer, description, failure, log) {
  const { file, ...identity } = description;
  const totalMs = Math.max(0, timer.now() - timer.origin);
  const stages = orderedStages(timer);
  const report = {
    schemaVersion: 1,
    kind: 'xr-collector-stage-timings',
    ...identity,
    status: failure ? 'failed' : 'passed',
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
    startedAt: new Date(timer.origin).toISOString(),
    totalMs,
    stages,
  };
  log(formatTimingTable(stages, { totalMs, title: `Stage timings: ${identity.command ?? 'run'} ${report.status}` }));
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    log(`Stage timing report: ${file}`);
  } catch (error) {
    log(`Unable to write the stage timing report ${file}: ${error instanceof Error ? error.message : error}`);
  }
  return report;
}

/**
 * electron-builder hooks run inside the builder child process. They append one JSON event per
 * line to the file named by this variable, and the packaging process reads them back after the
 * builder exits.
 */
export const BUILDER_TIMINGS_ENV = 'XR_PACKAGE_TIMINGS_FILE';

export async function appendBuilderTimingEvents(events, file = process.env[BUILDER_TIMINGS_ENV]) {
  if (!file || events.length === 0) return;
  await appendFile(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

/** Converts a hook's own timer into events that keep each stage's absolute start time. */
export function timerEvents(timer) {
  return timer.stages.map(({ name, ms, status, depth, startedAt, count, bytes }) => ({
    event: 'stage', name, ms, status, depth, startedAt, ...(count === undefined ? {} : { count }), ...(bytes === undefined ? {} : { bytes }),
  }));
}

/**
 * Records the builder hook events of one electron-builder run on `timer`, which is the child timer
 * of that run's stage. Marks become derived stages: packing (beforePack until afterPack starts),
 * the afterPack hook, electron-builder's own App codesign (afterPack end until afterSign), and
 * each artifact from its build start to completion.
 */
export async function recordBuilderTimings(timer, file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const marks = new Map(events.filter((event) => event.event === 'mark').map((event) => [event.name, event.at]));
  const between = (name, from, to) => {
    if (marks.has(from) && marks.has(to)) timer.record(name, { startedAt: marks.get(from), ms: marks.get(to) - marks.get(from) });
  };
  between('pack App (beforePack to afterPack)', 'beforePack', 'afterPack:start');
  const hookStages = events.filter((event) => event.event === 'stage');
  if (hookStages.length) between('afterPack hook', 'afterPack:start', 'afterPack:end');
  for (const { name, ms, status, depth, startedAt, count, bytes } of hookStages) {
    timer.record(`afterPack hook / ${name}`, { startedAt, ms, status, depth: depth + 1, count, bytes });
  }
  between('electron-builder App codesign (afterPack to afterSign)', 'afterPack:end', 'afterSign');
  const started = new Map(events.filter((event) => event.event === 'artifact:start').map((event) => [event.file, event.at]));
  for (const completed of events.filter((event) => event.event === 'artifact:end')) {
    const startedAt = started.get(completed.file);
    if (startedAt !== undefined) timer.record(`artifact ${path.basename(completed.file)}`, { startedAt, ms: completed.at - startedAt, bytes: completed.bytes });
  }
}

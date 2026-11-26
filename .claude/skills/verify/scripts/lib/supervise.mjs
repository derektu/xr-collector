import { statSync } from 'node:fs';
import path from 'node:path';
import { runWithinLimit, StoppedRun } from '../../../../../scripts/lib/time-limited-process.mjs';
import { FLOWS_RUN_LIMIT } from '../../../../../scripts/lib/time-limits.mjs';
import { readRecord, runProcesses, runsLaunchedBy, stopRun } from './instance.mjs';
import { runsRoot } from './paths.mjs';

const SUPERVISED = 'XR_VERIFY_FLOWS_SUPERVISED';

/** Whether this process is the flows run a supervisor started. */
export const supervised = () => process.env[SUPERVISED] === '1';

/**
 * Runs `node <args>` (a flows run) as a child and resolves with its exit code; its output goes to
 * this process's own. When the child runs past `limit` or this process gets SIGINT, SIGTERM or
 * SIGHUP, the child's group is ended and every run the child launched under `runs` since
 * the supervisor started is stopped (stopRun); the flows that were still running and the processes
 * ended are printed, and it resolves with the interruption's exit code.
 */
export async function superviseFlows(args, { limit = FLOWS_RUN_LIMIT, runs = runsRoot() } = {}) {
  const since = Date.now();
  try {
    return await runWithinLimit('flows run', process.execPath, args, { limit, environment: { ...process.env, [SUPERVISED]: '1' } });
  } catch (error) {
    if (!(error instanceof StoppedRun)) throw error;
    console.error(error.message);
    const launched = runsLaunchedBy(error.pid, runs).filter((runDir) => startedAt(runDir) >= since);
    for (const line of await Promise.all(launched.map(stopLeftRun))) console.error(line);
    return error.exitCode;
  }
}

function startedAt(runDir) {
  const recorded = Date.parse(readRecord(runDir)?.startedAt ?? '');
  return Number.isNaN(recorded) ? statSync(runDir).birthtimeMs : recorded;
}

async function stopLeftRun(runDir) {
  const record = readRecord(runDir);
  if (!record || record.unreadable) return `${runDir} has no readable run.json; its processes are left for you to end`;
  const flow = path.basename(record.evidence);
  const processes = runProcesses(record).map(({ pid, role }) => `${role} ${pid}`).join(', ') || 'none running';
  try {
    await stopRun(runDir);
    return `flow ${flow} was still running; stopped its run (${processes})`;
  } catch (error) {
    return `flow ${flow} was still running; stopping its run ${runDir} failed: ${error.message}`;
  }
}

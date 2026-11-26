import { execFileSync } from 'node:child_process';
import { constants } from 'node:os';
import { runOwnedProcess, terminateOwnedProcessTree, UnsafeProcessTreeError } from './owned-process.mjs';
import { deadline } from './wait.mjs';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * A command ended before it finished on its own: it ran past its limit, or this process got SIGINT,
 * SIGTERM or SIGHUP. Its group has been ended by then. `message` names the command and lists the
 * processes that were still running; `pid` is the command's own process, `exitCode` the code to
 * exit with: 1 past the limit, 128 plus the signal's number when interrupted.
 */
export class StoppedRun extends Error {
  constructor(message, { pid, exitCode }) {
    super(message);
    this.name = 'StoppedRun';
    this.pid = pid;
    this.exitCode = exitCode;
  }
}

/**
 * Runs `command` with `args` as `name` in its own process group (a process tree on Windows), with
 * the output going to this process's own, and resolves with its exit code. After `limit`
 * milliseconds, or on SIGINT, SIGTERM or SIGHUP to this process, it ends the command's group and
 * rejects with a `StoppedRun`. When the command exits while processes of its group still run (checked on POSIX
 * only), it ends them, prints a warning naming them and resolves with the command's exit code. A
 * process that leaves the group (a detached child) is not ended.
 */
export async function runWithinLimit(name, command, args, { limit, environment } = {}) {
  const controller = new AbortController();
  let pid;
  const stop = (message, exitCode) => {
    if (controller.signal.aborted) return;
    controller.abort(new StoppedRun(`${message}; ended the processes still running:${listed(groupMembers(pid))}`, { pid, exitCode }));
  };
  const onTimeout = () => stop(`${name} ran past its limit of ${formatLimit(limit)}`, 1);
  const onSignal = (signal) => stop(`${name} was interrupted (${signal})`, 128 + constants.signals[signal]);
  const timeout = deadline(limit);
  timeout.addEventListener('abort', onTimeout, { once: true });
  for (const signal of SIGNALS) process.on(signal, onSignal);
  try {
    await runOwnedProcess(command, args, {
      environment, stdio: 'inherit', signal: controller.signal,
      processTracker: { beforeSpawn: async () => {}, started: async (tree) => { pid = tree.pid; }, finished: async () => {} },
    });
    return 0;
  } catch (error) {
    if (error instanceof StoppedRun) throw error;
    if (error instanceof UnsafeProcessTreeError && !controller.signal.aborted) {
      const left = groupMembers(pid);
      if (left.length) {
        await terminateOwnedProcessTree(pid);
        console.error(`Warning: ${name} exited with processes of its group still running; ended them:${listed(left)}`);
        return Number.isInteger(error.exitCode) ? error.exitCode : 1;
      }
    }
    if (Number.isInteger(error.exitCode)) return error.exitCode;
    throw error;
  } finally {
    timeout.removeEventListener('abort', onTimeout);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }
}

const formatLimit = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms} ms`);

const listed = (processes) => processes.map(({ pid, command }) => `\n  ${pid} ${command}`).join('');

function groupMembers(pgid) {
  if (!Number.isInteger(pgid)) return [];
  if (process.platform === 'win32') return [{ pid: pgid, command: 'with the processes it started' }];
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter((match) => match && Number(match[2]) === pgid)
    .map((match) => ({ pid: Number(match[1]), command: match[3] }));
}

import { spawn } from 'node:child_process';
import path from 'node:path';

export class UnsafeProcessTreeError extends Error {
  constructor(message, processTree, options = {}) {
    super(message, options);
    this.name = 'UnsafeProcessTreeError';
    this.preserveOwnedResources = true;
    this.processTree = processTree;
  }
}

export async function runOwnedProcess(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const signal = options.signal;
  if (signal?.aborted) throw signal.reason ?? new Error('Owned process was aborted before launch.');
  const trackers = options.processTrackers ?? (options.processTracker ? [options.processTracker] : []);
  const preparedTrackers = [];
  try {
    for (const tracker of trackers) { await tracker.beforeSpawn(); preparedTrackers.push(tracker); }
  } catch (error) {
    await Promise.allSettled(preparedTrackers.map((tracker) => tracker.finished()));
    throw error;
  }
  return new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)(command, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let abortReason = null;
    let termination = null;
    const processTree = { platform, pid: child.pid, kind: platform === 'win32' ? 'windows-tree' : 'posix-process-group' };
    const trackingStarted = Number.isInteger(child.pid)
      ? Promise.all(trackers.map((tracker) => tracker.started(processTree)))
      : Promise.resolve();
    let settled = false;
    const settle = (callback, value) => { if (!settled) { settled = true; callback(value); } };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { spawnError = error; });
    const onAbort = () => {
      abortReason ??= signal.reason ?? new Error('Owned process was aborted.');
      if (Number.isInteger(child.pid)) {
        termination ??= terminateOwnedProcessTree(child.pid, { ...options, platform });
        termination.catch((error) => {
          signal?.removeEventListener('abort', onAbort);
          settle(reject, new UnsafeProcessTreeError(`Unable to confirm termination of process tree ${child.pid}.`, processTree, { cause: error }));
        });
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    trackingStarted.catch((error) => {
      if (!Number.isInteger(child.pid)) { settle(reject, error); return; }
      termination ??= terminateOwnedProcessTree(child.pid, { ...options, platform });
      termination.then(
        () => settle(reject, new UnsafeProcessTreeError(`Unable to persist ownership of process tree ${child.pid}.`, processTree, { cause: error })),
        (terminationError) => settle(reject, new UnsafeProcessTreeError(`Unable to persist or terminate process tree ${child.pid}.`, processTree,
          { cause: new AggregateError([error, terminationError]) })),
      );
    });
    child.once('close', async (code, closeSignal) => {
      signal?.removeEventListener('abort', onAbort);
      try { await trackingStarted; } catch { return; }
      try { if (termination) await termination; }
      catch { return; }
      if (!abortReason && Number.isInteger(child.pid) && platform !== 'win32') {
        try {
          if (await inspectOwnedProcessTree(processTree, options) !== false) {
            settle(reject, new UnsafeProcessTreeError(`Process group ${child.pid} outlived its root process.`, processTree));
            return;
          }
        } catch (error) {
          settle(reject, new UnsafeProcessTreeError(`Unable to inspect completed process group ${child.pid}.`, processTree, { cause: error }));
          return;
        }
      }
      try { await Promise.all(trackers.map((tracker) => tracker.finished())); }
      catch (error) {
        settle(reject, new UnsafeProcessTreeError(`Unable to clear ownership of completed process tree ${child.pid}.`, processTree, { cause: error }));
        return;
      }
      if (abortReason) { settle(reject, abortReason); return; }
      if (spawnError) { settle(reject, spawnError); return; }
      if (code !== 0) {
        settle(reject, new Error(`${path.basename(command)} exited with status ${code}${closeSignal ? ` (${closeSignal})` : ''}: ${(stderr || stdout).trim() || 'no diagnostic output'}`));
        return;
      }
      settle(resolve, { stdout, stderr });
    });
  });
}

export async function inspectOwnedProcessTree(processTree, options = {}) {
  if (processTree?.kind === 'posix-process-group' && Number.isInteger(processTree.pid)) {
    const exists = options.groupExists ?? ((target) => {
      try { process.kill(-target, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return null; throw error; }
    });
    return exists(processTree.pid);
  }
  if (processTree?.kind === 'windows-tree' && Number.isInteger(processTree.pid)) {
    // taskkill failure gives us no trustworthy descendant inventory after the
    // root exits. Keep the lock for manual recovery instead of guessing.
    return null;
  }
  throw new Error('Owned process-tree recovery metadata is invalid.');
}

export async function terminateOwnedProcessTree(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    await (options.runTaskkill ?? runTaskkill)(pid, options);
    return;
  }
  const send = options.killGroup ?? ((target, signal) => process.kill(-target, signal));
  const exists = options.groupExists ?? ((target) => {
    try { process.kill(-target, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
  });
  if (!await sendGroupSignal(pid, 'SIGTERM', send, options)) return;
  if (await waitUntilGone(pid, exists, options)) return;
  if (!await sendGroupSignal(pid, 'SIGKILL', send, options)) return;
  if (!await waitUntilGone(pid, exists, options)) throw new Error(`POSIX process group ${pid} remained alive after SIGKILL.`);
}

async function runTaskkill(pid, options) {
  const taskkill = options.spawnTaskkill ?? spawn;
  await new Promise((resolve, reject) => {
    const child = taskkill('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`taskkill.exe exited with status ${code}: ${output.trim() || 'no diagnostic output'}`)));
  });
}

async function waitUntilGone(pid, exists, options) {
  const timeoutMs = options.terminationTimeoutMs ?? 5_000;
  const intervalMs = options.terminationPollMs ?? 25;
  const sleep = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  while (exists(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
  return true;
}

async function sendGroupSignal(pid, signal, send, options) {
  const timeoutMs = options.terminationTimeoutMs ?? 5_000;
  const intervalMs = options.terminationPollMs ?? 25;
  const sleep = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { send(pid, signal); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code !== 'EPERM' || Date.now() >= deadline) throw error;
      await sleep(intervalMs);
    }
  }
}

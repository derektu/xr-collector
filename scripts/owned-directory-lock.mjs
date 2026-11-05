import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Mutual exclusion rests on one atomic step: creating the lock directory succeeds for exactly one
// process while the directory exists, and that process holds the lock. The only code that removes a
// lock directory is its holder's release, so a directory stays its creator's until the creator
// releases it. Everything else here only reads the lock to choose between waiting, reporting busy,
// and reporting a lock whose holder has ended; a lock left behind is never removed automatically,
// because no single file-system step can tell that it is still abandoned at the moment of removal.

/** The error code of a lock its holder left behind. */
export const OWNED_LOCK_LEFT_BEHIND = 'OWNED_LOCK_LEFT_BEHIND';

const OWNER_FILE = /^owner-([0-9a-f]+)\.json$/u;
// Windows reports EPERM for a lock directory whose deletion its holder has begun but not finished
// while another handle still has it open. That state clears within milliseconds, so the attempt
// repeats up to this many times before the error stands.
const PENDING_DELETE_ATTEMPTS = 50;

/**
 * Runs `work` while holding the directory lock at `lockPath`. A lock held by a live process, or by
 * an ended one whose recorded child processes may still run, reports `options.busyMessage` (after
 * waiting, when `options.waitForBusy`). A lock whose holder and recorded children have all ended
 * fails with an error that names the holder, the lock path and the command that deletes it once
 * no `options.holderDescription` is running.
 */
export async function withOwnedDirectoryLock(lockPath, work, options) {
  const token = (options.randomToken ?? (() => randomBytes(16).toString('hex')))();
  if (!/^[0-9a-f]+$/u.test(token)) throw new Error('Owned lock token must be lowercase hexadecimal.');
  const owner = { ...await options.ownerIdentity(), token };
  assertOwner(owner, token);
  const lockOptions = { ...options, expectedUid: owner.uid };
  const handle = await acquire(lockPath, owner, lockOptions);
  const processTracker = {
    beforeSpawn: () => updateProcessState(handle, { status: 'starting' }),
    started: (processTree) => updateProcessState(handle, { status: 'active', processTree }),
    finished: () => updateProcessState(handle, null),
  };
  let workError;
  try {
    return await work(processTracker);
  } catch (error) {
    workError = error;
    if (error?.preserveOwnedResources) {
      try { await markUnsafeProcessTree(handle, error.processTree); }
      catch (markError) {
        const failure = new AggregateError([error, markError], 'Owned process termination and persistent lock marking both failed.');
        failure.preserveOwnedResources = true;
        workError = failure;
        throw failure;
      }
    }
    throw error;
  } finally {
    if (!workError?.preserveOwnedResources) {
      try { await release(handle); }
      catch (releaseError) {
        if (workError) throw new AggregateError([workError, releaseError], 'Owned work failed and its lock could not be released safely.');
        throw releaseError;
      }
    }
  }
}

async function acquire(lockPath, owner, options) {
  let busyAttempts = 0;
  let pendingDeleteAttempts = 0;
  const waitOutPendingDelete = async (error) => {
    if ((options.platform ?? process.platform) !== 'win32' || (error?.code ?? error?.cause?.code) !== 'EPERM'
      || ++pendingDeleteAttempts > PENDING_DELETE_ATTEMPTS) throw error;
    await (options.delay ?? delay)(10);
  };
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') { await waitOutPendingDelete(error); continue; }
      let state;
      try { state = await inspectExisting(lockPath, options); }
      catch (inspectError) { await waitOutPendingDelete(inspectError); continue; }
      if (state === 'retry') continue;
      if (!options.waitForBusy || busyAttempts >= (options.maxBusyAttempts ?? 0)) throw new Error(options.busyMessage);
      busyAttempts += 1;
      await (options.delay ?? delay)(options.retryDelayMs ?? 100);
      continue;
    }
    return recordOwner(lockPath, owner);
  }
}

/** Writes the owner record into the directory this process just created, which no one else removes. */
async function recordOwner(lockPath, owner) {
  const ownerPath = path.join(lockPath, `owner-${owner.token}.json`);
  try {
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(ownerPath, { force: true }).catch(() => {});
    await rmdir(lockPath).catch(() => {});
    throw error;
  }
  return { lockPath, ownerPath, owner };
}

/**
 * Reads a lock another process created: 'retry' when it disappeared while being read, 'busy' when
 * its holder or a recorded child process may still run. Throws for a lock its holder left behind
 * and for metadata it cannot interpret.
 */
async function inspectExisting(lockPath, options) {
  let directory;
  let entries;
  try {
    directory = await describeDirectory(lockPath, options.expectedUid, options);
    entries = await readdir(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return 'retry';
    throw error;
  }
  const age = Date.now() - directory.mtimeMs;
  const withinOwnerGrace = age < (options.ownerGraceMs ?? 5_000);
  const owners = entries.filter((entry) => OWNER_FILE.test(entry));
  if (owners.length === 0 && entries.length === 0) {
    // The creator records itself right after creating the directory.
    if (withinOwnerGrace) return 'busy';
    throw leftBehind(lockPath, `has had no owner record for ${Math.round(age / 1000)} seconds since it was created; the process that created it ended before recording itself`, options);
  }
  const ambiguous = () => new Error(`Owned lock ${lockPath} has invalid or ambiguous owner metadata.`);
  if (owners.length !== 1) throw ambiguous();
  const ownerName = owners[0];
  // A live holder replaces its owner file through a temporary sibling while it records process state.
  const pendingUpdates = entries.filter((entry) => entry.startsWith(`${ownerName}.update-`));
  if (entries.length !== 1 + pendingUpdates.length) throw ambiguous();
  const token = OWNER_FILE.exec(ownerName)?.[1];
  let content;
  try {
    await assertOwnerFile(path.join(lockPath, ownerName), options.expectedUid, options);
    content = await readFile(path.join(lockPath, ownerName), 'utf8');
  } catch (error) {
    // The holder releasing the lock removes its owner file between the listing and this read.
    if (error.code === 'ENOENT') return 'retry';
    throw new Error(`Owned lock ${lockPath} has invalid owner metadata.`, { cause: error });
  }
  // A contender that has just created the directory opens its owner file before writing it.
  if (content === '') {
    if (withinOwnerGrace) return 'busy';
    throw leftBehind(lockPath, `has had an empty owner record for ${Math.round(age / 1000)} seconds since it was created; the process that created it ended before recording itself`, options);
  }
  let recorded;
  try { recorded = JSON.parse(content); }
  catch (error) { throw new Error(`Owned lock ${lockPath} has invalid owner metadata.`, { cause: error }); }
  assertOwner(recorded, token);
  const current = await options.inspectOwner(recorded.pid);
  if (sameProcess(current, recorded)) return 'busy';
  if (recorded.processState?.status === 'starting') return 'busy';
  if (recorded.processState?.status === 'active') {
    const active = await options.inspectUnsafeTree(recorded.processState.processTree);
    if (active !== false) return 'busy';
  }
  if (recorded.unsafeProcessTree) {
    const active = await options.inspectUnsafeTree(recorded.unsafeProcessTree);
    if (active !== false) return 'busy';
  }
  throw leftBehind(lockPath, `was left by process ${recorded.pid} (started ${recorded.startedAt}), which has ended, as have the child processes it recorded`, options);
}

/**
 * The error for a lock its holder left behind. `detail` and `fix` split the message into what was
 * found and what to do, for reports that show the two apart.
 */
function leftBehind(lockPath, reason, options) {
  const holder = options.holderDescription ?? 'run that uses this lock';
  const detail = `Owned lock ${lockPath} ${reason}. The lock is not removed automatically.`;
  const fix = `Confirm that no ${holder} is running, then delete it with: ${removeCommand(lockPath, options.platform ?? process.platform)}`;
  const error = new Error(`${detail} ${fix}`);
  Object.assign(error, { code: OWNED_LOCK_LEFT_BEHIND, lockPath, detail, fix });
  return error;
}

// PowerShell treats U+2018 through U+201B as single quotes too; each is escaped by doubling it.
function removeCommand(lockPath, platform) {
  return platform === 'win32'
    ? `Remove-Item -LiteralPath '${lockPath.replace(/['\u2018-\u201B]/gu, '$&$&')}' -Recurse`
    : `rm -r '${lockPath.replaceAll("'", "'\\''")}'`;
}

/**
 * Removes the owner record, then the directory. The record's name carries this run's random token,
 * so removing it succeeds only in the directory this run created; a lock someone deleted and another
 * run re-created is left as found.
 */
async function release(handle) {
  try { await unlink(handle.ownerPath); }
  catch (error) {
    throw new Error(`Owned lock ${handle.lockPath} no longer holds this run's owner record; it was removed while held and is left as found.`, { cause: error });
  }
  try { await rmdir(handle.lockPath); }
  catch (error) {
    throw new Error(`Owned lock ${handle.lockPath} could not be removed after releasing its owner nonce.`, { cause: error });
  }
}

async function markUnsafeProcessTree(handle, processTree) {
  await updateOwnedMetadata(handle, (recorded) => ({ ...recorded, unsafeProcessTree: processTree }));
}

async function updateProcessState(handle, processState) {
  await updateOwnedMetadata(handle, (recorded) => {
    const next = { ...recorded };
    if (processState) next.processState = processState;
    else delete next.processState;
    return next;
  });
}

async function updateOwnedMetadata(handle, update) {
  const recorded = JSON.parse(await readFile(handle.ownerPath, 'utf8'));
  if (!sameOwner(recorded, handle.owner)) throw new Error(`Owned lock ${handle.lockPath} changed before its metadata could be updated.`);
  const temporary = `${handle.ownerPath}.update-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(update(recorded))}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, handle.ownerPath);
  } finally { await rm(temporary, { force: true }); }
}

async function describeDirectory(lockPath, expectedUid, options) {
  const info = await lstat(lockPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Owned lock ${lockPath} is not a non-symlink directory.`);
  if ((options.platform ?? process.platform) !== 'win32'
    && ((info.mode & 0o077) !== 0 || (expectedUid !== undefined && info.uid !== expectedUid))) {
    throw new Error(`Owned lock ${lockPath} does not have its expected owner-only directory permissions.`);
  }
  return { mtimeMs: info.mtimeMs };
}

async function assertOwnerFile(ownerPath, expectedUid, options) {
  const info = await lstat(ownerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Owned lock owner ${ownerPath} is not a private regular file.`);
  if ((options.platform ?? process.platform) !== 'win32'
    && ((info.mode & 0o077) !== 0 || (expectedUid !== undefined && info.uid !== expectedUid))) {
    throw new Error(`Owned lock owner ${ownerPath} does not have its expected owner-only file permissions.`);
  }
}

function assertOwner(owner, expectedToken) {
  if (!Number.isInteger(owner?.pid) || !['number', 'string'].includes(typeof owner.uid)
    || owner.uid === '' || typeof owner.startedAt !== 'string' || !owner.startedAt
    || typeof owner.token !== 'string' || owner.token !== expectedToken) {
    throw new Error('Owned lock owner identity is invalid.');
  }
}

function sameProcess(left, right) {
  return left !== null && left !== undefined
    && left.pid === right.pid && left.uid === right.uid && left.startedAt === right.startedAt;
}
function sameOwner(left, right) { return sameProcess(left, right) && left.token === right.token; }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

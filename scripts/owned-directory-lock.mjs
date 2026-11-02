import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OWNER_FILE = /^owner-([0-9a-f]+)\.json$/u;
// Windows reports EPERM for a path whose deletion another handle has begun but not finished, as when
// a competing process reclaims the same stale owner. That state clears within milliseconds, so the
// attempt repeats up to this many times before the error stands.
const PENDING_DELETE_ATTEMPTS = 50;

export async function withOwnedDirectoryLock(lockPath, work, options) {
  const token = (options.randomToken ?? (() => randomBytes(16).toString('hex')))();
  if (!/^[0-9a-f]+$/u.test(token)) throw new Error('Owned lock token must be lowercase hexadecimal.');
  const owner = { ...await options.ownerIdentity(), token };
  assertOwner(owner, token);
  const lockOptions = { ...options, expectedUid: owner.uid };
  const handle = await acquire(lockPath, owner, lockOptions);
  const processTracker = {
    beforeSpawn: () => updateProcessState(handle, { status: 'starting' }, lockOptions),
    started: (processTree) => updateProcessState(handle, { status: 'active', processTree }, lockOptions),
    finished: () => updateProcessState(handle, null, lockOptions),
  };
  let workError;
  try {
    return await work(processTracker);
  } catch (error) {
    workError = error;
    if (error?.preserveOwnedResources) {
      try { await markUnsafeProcessTree(handle, error.processTree, lockOptions); }
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
      try { await release(handle, lockOptions); }
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
      const handle = await claimCreatedDirectory(lockPath, owner, options);
      if (handle) return handle;
      continue;
    } catch (error) {
      if (error.code !== 'EEXIST') { await waitOutPendingDelete(error); continue; }
    }

    let state;
    try { state = await inspectExisting(lockPath, options); }
    catch (error) { await waitOutPendingDelete(error); continue; }
    if (state === 'retry') continue;
    if (state === 'busy') {
      if (!options.waitForBusy || busyAttempts >= (options.maxBusyAttempts ?? 0)) throw new Error(options.busyMessage);
      busyAttempts += 1;
      await (options.delay ?? delay)(options.retryDelayMs ?? 100);
    }
  }
}

// Until the owner nonce is written and confirmed, the directory this contender created is still exposed
// to the others: a reaper finishing a stale owner can remove it by path, and another contender can then
// create a replacement. Either way this attempt lost the race and returns null so acquisition starts
// over. Failures while the directory first observed after creation is still in place propagate.
async function claimCreatedDirectory(lockPath, owner, options) {
  const ownerName = `owner-${owner.token}.json`;
  const ownerPath = path.join(lockPath, ownerName);
  let directoryIdentity;
  try { directoryIdentity = await describeDirectory(lockPath, owner.uid, options); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    await assertExclusiveOwnership(lockPath, ownerName, owner, directoryIdentity, options);
    return { lockPath, ownerPath, ownerName, owner, directoryIdentity };
  } catch (error) {
    // A nonce written into a replacement directory belongs to no one, so it is removed either way.
    await removeOnlyMatchingOwner(ownerPath, owner, options).catch(() => {});
    let current;
    try { current = await lstat(lockPath); }
    catch (inspectError) { if (inspectError.code === 'ENOENT') return null; throw error; }
    if (!sameDirectory(current, directoryIdentity)) return null;
    await rmdir(lockPath).catch(() => {});
    throw error;
  }
}

// Removes the lock directory only while it is still the one inspected, leaving a replacement that a
// competing contender has already created in its place.
async function removeInspectedDirectory(lockPath, directoryIdentity) {
  try {
    if (!sameDirectory(await lstat(lockPath), directoryIdentity)) return;
    await rmdir(lockPath);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

async function inspectExisting(lockPath, options) {
  let directoryIdentity;
  let entries;
  try {
    directoryIdentity = await describeDirectory(lockPath, options.expectedUid, options);
    entries = await readdir(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return 'retry';
    throw error;
  }
  const withinOwnerGrace = Date.now() - directoryIdentity.mtimeMs < (options.ownerGraceMs ?? 5_000);
  const owners = entries.filter((entry) => OWNER_FILE.test(entry));
  if (owners.length === 0 && entries.length === 0) {
    if (withinOwnerGrace) return 'busy';
    await removeInspectedDirectory(lockPath, directoryIdentity);
    return 'retry';
  }
  const ambiguous = () => new Error(`Owned lock ${lockPath} has invalid or ambiguous owner metadata.`);
  if (owners.length !== 1) throw ambiguous();
  const ownerName = owners[0];
  // A live holder replaces its owner file through a temporary sibling while it records process state.
  const pendingUpdates = entries.filter((entry) => entry.startsWith(`${ownerName}.update-`));
  if (entries.length !== 1 + pendingUpdates.length) throw ambiguous();
  const token = OWNER_FILE.exec(ownerName)?.[1];
  let recorded;
  try {
    await assertOwnerFile(path.join(lockPath, ownerName), options.expectedUid, options);
    recorded = JSON.parse(await readFile(path.join(lockPath, ownerName), 'utf8'));
  } catch (error) {
    // The holder releasing the lock removes its owner file between the listing and this read.
    if (error.code === 'ENOENT') return 'retry';
    // A contender that has just created the directory opens its owner file before writing it.
    if (error instanceof SyntaxError && withinOwnerGrace) return 'busy';
    throw new Error(`Owned lock ${lockPath} has invalid owner metadata.`, { cause: error });
  }
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
  // An update file beside a dead owner was left by an interrupted write and is not reclaimed.
  if (pendingUpdates.length > 0) throw ambiguous();
  // Delete only the nonce file observed for the dead owner. A competing reaper
  // that already replaced the directory cannot have created this exact path.
  // A successful unlink does not make this reaper the only one: macOS reports
  // success to each of several concurrent unlinks of the same path.
  try { await unlink(path.join(lockPath, ownerName)); }
  catch (error) { if (error.code === 'ENOENT') return 'retry'; throw error; }
  await removeInspectedDirectory(lockPath, directoryIdentity);
  return 'retry';
}

async function release(handle, options) {
  await assertExclusiveOwnership(handle.lockPath, handle.ownerName, handle.owner, handle.directoryIdentity, options);
  await unlink(handle.ownerPath);
  try { await rmdir(handle.lockPath); }
  catch (error) {
    throw new Error(`Owned lock ${handle.lockPath} could not be removed after releasing its owner nonce.`, { cause: error });
  }
}

async function assertExclusiveOwnership(lockPath, ownerName, owner, expectedDirectory, options) {
  const actualDirectory = await describeDirectory(lockPath, owner.uid, options);
  if (!sameDirectory(actualDirectory, expectedDirectory)) throw new Error(`Owned lock ${lockPath} directory identity changed during acquisition.`);
  const entries = await readdir(lockPath);
  if (entries.length !== 1 || entries[0] !== ownerName) throw new Error(`Owned lock ${lockPath} ownership changed unexpectedly.`);
  await assertOwnerFile(path.join(lockPath, ownerName), owner.uid, options);
  const recorded = JSON.parse(await readFile(path.join(lockPath, ownerName), 'utf8'));
  if (!sameOwner(recorded, owner)) throw new Error(`Owned lock ${lockPath} owner nonce changed unexpectedly.`);
}

async function removeOnlyMatchingOwner(ownerPath, expected, options) {
  let recorded;
  try {
    await assertOwnerFile(ownerPath, expected.uid, options);
    recorded = JSON.parse(await readFile(ownerPath, 'utf8'));
  }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (sameOwner(recorded, expected)) await unlink(ownerPath);
}

async function markUnsafeProcessTree(handle, processTree, options) {
  await updateOwnedMetadata(handle, (recorded) => ({ ...recorded, unsafeProcessTree: processTree }), options);
}

async function updateProcessState(handle, processState, options) {
  await updateOwnedMetadata(handle, (recorded) => {
    const next = { ...recorded };
    if (processState) next.processState = processState;
    else delete next.processState;
    return next;
  }, options);
}

async function updateOwnedMetadata(handle, update, options) {
  await assertExclusiveOwnership(handle.lockPath, handle.ownerName, handle.owner, handle.directoryIdentity, options);
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
  return { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs };
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
function sameDirectory(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

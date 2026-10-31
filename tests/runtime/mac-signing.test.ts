import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RUNTIME_SIGNING_CONCURRENCY, describeArtifact, loadMacSigningConfiguration, mapConcurrent, notarizeAndStaple, parseProtectedEnvironment, parseUserKeychainList,
  selectDeveloperIdIdentity, signStagedMacRuntimes, signedBuilderEnvironment, validateNotarizedApplication,
  verifyDeveloperIdApplication, verifyDeveloperIdDiskImage, verifySignedRuntimeInventory, withTemporarySigningKeychain,
} from '../../scripts/mac-signing.mjs';
import { UnsafeProcessTreeError } from '../../scripts/owned-process.mjs';

const roots: string[] = [];
const describeStableCodeIdentity = async () => ({ teamId: 'ABCDE12345', cdHash: 'a'.repeat(40), identifier: 'com.moneydj.xrcollector' });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function privateSigningRoot(prefix = 'xr-signing-test-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

it.skipIf(process.platform === 'win32')('loads only the exact protected credential contract under an explicit root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-signing-config-'));
  roots.push(root);
  await writeFile(path.join(root, 'certificate.p12'), 'p12', { mode: 0o600 });
  await writeFile(path.join(root, 'AuthKey_ABCDEFGHIJ.p8'), 'p8', { mode: 0o600 });
  const environmentFile = path.join(root, '.env');
  await writeFile(environmentFile, [
    'CSC_LINK=certificate.p12', 'CSC_KEY_PASSWORD="secret value"', 'APPLE_API_KEY=AuthKey_ABCDEFGHIJ.p8',
    'APPLE_API_KEY_ID=ABCDEFGHIJ', 'APPLE_API_ISSUER=12345678-1234-1234-1234-123456789abc', 'APPLE_TEAM_ID=ABCDE12345', '',
  ].join('\n'), { mode: 0o600 });
  await expect(loadMacSigningConfiguration({ environmentFile, pathRoot: root })).resolves.toMatchObject({
    policy: 'developer-id-notarized', certificatePassword: 'secret value', teamId: 'ABCDE12345',
    notary: { keyId: 'ABCDEFGHIJ', issuer: '12345678-1234-1234-1234-123456789abc', teamId: 'ABCDE12345' },
  });
  expect(() => parseProtectedEnvironment('CSC_LINK=a\nEXTRA_SECRET=no\n')).toThrow(/unsupported key EXTRA_SECRET/u);
  await chmod(environmentFile, 0o644);
  await expect(loadMacSigningConfiguration({ environmentFile, pathRoot: root })).rejects.toThrow(/only by its owner/u);
});

// This and the following temporary signing keychain cases skip Windows: they depend on POSIX
// behavior it lacks, owner-only directory permissions, process identity through /bin/ps and POSIX signals.
it.skipIf(process.platform === 'win32')('appends its keychain without reordering existing sessions and removes only its owned keychain', async () => {
  const tempRoot = await privateSigningRoot();
  const calls: string[][] = [];
  const existingKeychains = [path.resolve('fixture/login.keychain-db'), path.resolve('fixture/other-session.keychain-db')];
  let keychains = [...existingKeychains];
  const run = vi.fn(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: `${keychains.map((entry) => `    ${JSON.stringify(entry)}`).join('\n')}\n`, stderr: '' };
    if (args[0] === 'delete-keychain') { keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    return args[0] === 'find-identity'
      ? { stdout: `  1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"\n`, stderr: '' }
      : { stdout: '', stderr: '' };
  });
  const configuration = { certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' };
  await expect(withTemporarySigningKeychain(configuration, async ({ keychain, identity }) => {
    expect(keychain).toMatch(/signing\.keychain-db$/u);
    expect(identity).toMatchObject({ sha1: 'A'.repeat(40), teamId: 'ABCDE12345' });
    keychains.push(path.resolve('fixture/concurrent-session.keychain-db'));
    return 'done';
  }, { run, randomPassword: () => 'temporary-password', tempRoot,
    keychainSearchLock: path.join(tempRoot, 'search-list.lock') })).resolves.toBe('done');
  const set = calls.find((args) => args[0] === 'list-keychains' && args[3] === '-s')!;
  expect(set.slice(4, -1)).toEqual(existingKeychains);
  expect(set.at(-1)).toMatch(/signing\.keychain-db$/u);
  expect(calls.filter((args) => args[0] === 'delete-keychain')).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'list-keychains' && args[3] === '-s')).toHaveLength(1);
  expect(keychains).toEqual([...existingKeychains, path.resolve('fixture/concurrent-session.keychain-db')]);
  expect(parseUserKeychainList(existingKeychains.map((entry) => `    ${JSON.stringify(entry)}`).join('\n'))).toEqual(existingKeychains);
  expect(calls.find((args) => args[0] === 'set-keychain-settings')).toContain('900');
  expect(calls.find((args) => args[0] === 'import')).not.toContain('/usr/bin/security');
});

it.skipIf(process.platform === 'win32')('recovers a SIGKILL-stale signing keychain without touching a live session', async () => {
  const universe = await privateSigningRoot('xr-mac-signing-scope-');
  const tempRoot = path.join(universe, 'chosen-root');
  await mkdir(tempRoot, { mode: 0o700 });
  const stale = await mkdtemp(path.join(tempRoot, 'xr-mac-signing-'));
  const live = await mkdtemp(path.join(tempRoot, 'xr-mac-signing-'));
  const external = await mkdtemp(path.join(universe, 'xr-mac-signing-'));
  const uid = process.getuid?.() ?? 501;
  await writeFile(path.join(stale, 'owner.json'), JSON.stringify({ pid: 41, uid, startedAt: 'old' }));
  await writeFile(path.join(stale, 'signing.keychain-db'), 'stale');
  await writeFile(path.join(live, 'owner.json'), JSON.stringify({ pid: 42, uid, startedAt: 'live' }));
  await writeFile(path.join(live, 'signing.keychain-db'), 'live');
  await writeFile(path.join(external, 'owner.json'), JSON.stringify({ pid: 43, uid, startedAt: 'external' }));
  await writeFile(path.join(external, 'signing.keychain-db'), 'external');
  let keychains = [path.join(stale, 'signing.keychain-db'), path.join(live, 'signing.keychain-db'), path.join(external, 'signing.keychain-db')];
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'delete-keychain') { keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const processIdentity = vi.fn(async (pid: number) => pid === 42 ? { pid, uid, startedAt: 'live' }
    : pid === process.pid ? { pid, uid, startedAt: 'current' } : null);
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = universe;
  try {
    await withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => undefined, {
      run, randomPassword: () => 'temporary-password', tempRoot, keychainSearchLock: path.join(tempRoot, 'search-list.lock'), processIdentity,
    });
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
  }
  await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(live)).resolves.toBeDefined();
  await expect(stat(external)).resolves.toBeDefined();
  expect(processIdentity).not.toHaveBeenCalledWith(43);
  expect(keychains).toEqual([path.join(live, 'signing.keychain-db'), path.join(external, 'signing.keychain-db')]);
});

it.skipIf(process.platform === 'win32')('fails closed when a stale-session process identity cannot be inspected', async () => {
  const tempRoot = await privateSigningRoot();
  const stale = await mkdtemp(path.join(tempRoot, 'xr-mac-signing-'));
  await writeFile(path.join(stale, 'owner.json'), JSON.stringify({ pid: 41, uid: process.getuid?.(), startedAt: 'unknown' }));
  await writeFile(path.join(stale, 'signing.keychain-db'), 'private-key');
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => undefined, {
    run: async () => ({ stdout: '', stderr: '' }),
    processIdentity: async () => { throw new Error('ps unavailable'); }, tempRoot,
    keychainSearchLock: path.join(tempRoot, 'search-list.lock'),
  })).rejects.toThrow(/ps unavailable/u);
  await expect(stat(path.join(stale, 'signing.keychain-db'))).resolves.toBeDefined();
});

it.skipIf(process.platform === 'win32')('deletes its temporary keychain when the terminal sends SIGTERM', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-signing-signal-'));
  roots.push(root);
  const signalTarget = new EventEmitter();
  let keychains: string[] = [];
  let deleted = '';
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'delete-keychain') { deleted = args[1]!; keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  let owned = '';
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async ({ keychain, signal }) => {
    owned = keychain;
    signalTarget.emit('SIGTERM');
    signal.throwIfAborted();
  }, { run, signalTarget, terminateAfterSignal: () => {}, randomPassword: () => 'temporary-password', tempRoot: root,
    keychainSearchLock: path.join(root, 'search-list.lock') })).rejects.toThrow(/SIGTERM/u);
  expect(deleted).toBe(owned);
});

it.skipIf(process.platform === 'win32')('preserves its signing session and shared lock when cleanup cannot confirm process-tree termination', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-signing-unsafe-cleanup-'));
  roots.push(root);
  const session = path.join(root, 'xr-mac-signing-session');
  const sharedLock = path.join(root, 'search-list.lock');
  await mkdir(session, { mode: 0o700 });
  let keychains: string[] = [];
  const tree = { platform: 'darwin', pid: 4242, kind: 'posix-process-group' };
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    if (args[0] === 'delete-keychain') throw new UnsafeProcessTreeError('tree is not confirmed stopped', tree);
    return { stdout: '', stderr: '' };
  };
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => 'done', {
    run, mkdtemp: async () => session, realpath: async (value: string) => value,
    processIdentity: async (pid: number) => ({ pid, uid: process.getuid?.() ?? 501, startedAt: 'current' }),
    keychainSearchLock: sharedLock, randomPassword: () => 'temporary-password', tempRoot: root,
  })).rejects.toMatchObject({ preserveOwnedResources: true, processTree: tree });
  await expect(stat(session)).resolves.toBeDefined();
  const [sharedOwner] = await readdir(sharedLock);
  expect(JSON.parse(await readFile(path.join(sharedLock, sharedOwner!), 'utf8'))).toMatchObject({ unsafeProcessTree: tree });
});

it.skipIf(process.platform === 'win32')('a real packaging subprocess aborts its security child before append and removes keychain plus lock on SIGTERM', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-signing-signal-process-'));
  roots.push(root);
  const session = path.join(root, 'xr-mac-signing-session');
  const lock = path.join(root, 'package.lock');
  const ready = path.join(root, 'security-started');
  const appended = path.join(root, 'search-list-appended');
  const packageModule = pathToFileURL(path.resolve('scripts/package-app.mjs')).href;
  const signingModule = pathToFileURL(path.resolve('scripts/mac-signing.mjs')).href;
  const uid = process.getuid?.() ?? 501;
  const script = `
    import { spawn } from 'node:child_process';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { withPackageCheckoutLock } from ${JSON.stringify(packageModule)};
    import { withTemporarySigningKeychain } from ${JSON.stringify(signingModule)};
    const paths = ${JSON.stringify({ root, session, lock, ready, appended })};
    const run = async (_command, args, options = {}) => {
      if (args[0] === 'create-keychain') {
        await writeFile(args.at(-1), 'private-key');
        await writeFile(paths.ready, 'ready');
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: options.signal });
          child.once('error', reject);
          child.once('exit', (code, signal) => signal ? reject(new Error('fake security interrupted by ' + signal)) : code === 0 ? resolve() : reject(new Error('fake security failed')));
        });
      }
      if (args[0] === 'list-keychains' && args[3] === '-s') await writeFile(paths.appended, 'appended');
      if (args[0] === 'list-keychains') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    try {
      await withPackageCheckoutLock(paths.lock, ({ signal }) => withTemporarySigningKeychain(
        { certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' },
        async () => {},
        { signal, run, mkdtemp: async () => { await mkdir(paths.session, { mode: 0o700 }); return paths.session; }, realpath: async (value) => value,
          processIdentity: async (pid) => ({ pid, uid: ${JSON.stringify(uid)}, startedAt: 'child' }), tempRoot: paths.root,
          keychainSearchLock: paths.root + '/search-list.lock' }
      ));
    } catch (error) {
      if (!process.exitCode) { console.error(error); process.exitCode = 1; }
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await stat(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  await stat(ready);
  child.kill('SIGTERM');
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  expect(exit.signal).toBeNull();
  expect(exit.code).toBe(143);
  expect(stderr).toBe('');
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(session)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(appended)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('uses one canonical owned keychain path when macOS rewrites /var as /private/var', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-keychain-alias-test-'));
  roots.push(root);
  const requestedDirectory = '/var/folders/fixture/xr-mac-signing-alias';
  const canonicalDirectory = '/private/var/folders/fixture/xr-mac-signing-alias';
  let keychains = ['/Users/example/Library/Keychains/login.keychain-db'];
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    if (args[0] === 'delete-keychain') { keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async ({ keychain }) => {
    expect(keychain).toBe(`${canonicalDirectory}/signing.keychain-db`);
  }, {
    run, mkdtemp: async () => requestedDirectory, realpath: async (value: string) => value.replace(/^\/var\//u, '/private/var/'),
    writeFile: async () => {}, inspectDirectory: async () => ({ isDirectory: () => true, mode: 0o700, uid: process.getuid?.() }),
    randomPassword: () => 'temporary-password', keychainSearchLock: path.join(root, 'search-list.lock'), tempRoot: root,
  })).resolves.toBeUndefined();
  const append = calls.find((args) => args[0] === 'list-keychains' && args[3] === '-s')!;
  expect(append.at(-1)).toBe(`${canonicalDirectory}/signing.keychain-db`);
  expect(calls.find((args) => args[0] === 'delete-keychain')?.[1]).toBe(`${canonicalDirectory}/signing.keychain-db`);
  expect(keychains).toEqual(['/Users/example/Library/Keychains/login.keychain-db']);
});

it.skipIf(process.platform === 'win32')('preserves concurrent keychains and aggregates the work and owned-keychain deletion failures', async () => {
  const tempRoot = await privateSigningRoot();
  const existing = path.resolve('fixture/login.keychain-db');
  const concurrent = path.resolve('fixture/concurrent-session.keychain-db');
  let keychains = [existing];
  let owned = '';
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: `${keychains.map((entry) => JSON.stringify(entry)).join('\n')}\n`, stderr: '' };
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"\n`, stderr: '' };
    if (args[0] === 'delete-keychain') throw new Error('simulated owned keychain deletion failure');
    return { stdout: '', stderr: '' };
  });
  const configuration = { certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' };
  let failure: unknown;
  try {
    await withTemporarySigningKeychain(configuration, async ({ keychain }) => {
      owned = keychain;
      keychains.push(concurrent);
      throw new Error('simulated signing failure');
    }, { run, randomPassword: () => 'temporary-password', tempRoot,
      keychainSearchLock: path.join(tempRoot, 'search-list.lock') });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
    'Error: simulated signing failure', 'Error: simulated owned keychain deletion failure',
  ]);
  expect(keychains).toEqual([existing, concurrent]);
  expect(keychains).not.toContain(owned);
  expect(run.mock.calls.filter(([, args]) => args[0] === 'list-keychains' && args[3] === '-s')).toHaveLength(2);
});

it.skipIf(process.platform === 'win32')('reclaims only a shared keychain-list lock whose recorded owner process is gone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-stale-keychain-lock-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  const uid = process.getuid?.() ?? 501;
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), JSON.stringify({ pid: 424242, uid, startedAt: 'stale', token: 'a1' }), { mode: 0o600 });
  let keychains: string[] = [];
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    if (args[0] === 'delete-keychain') { keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => 'done', {
    run, randomPassword: () => 'temporary-password', keychainSearchLock: lock, tempRoot: root,
    processIdentity: async (pid: number) => pid === process.pid ? { pid, uid, startedAt: 'current' } : null,
  })).resolves.toBe('done');
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('reclaims an ownerless shared lock after its creation grace but fails closed on malformed ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-ownerless-keychain-lock-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  await mkdir(lock, { mode: 0o700 });
  let keychains: string[] = [];
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    if (args[0] === 'delete-keychain') { keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => 'done', {
    run, randomPassword: () => 'temporary-password', keychainSearchLock: lock, keychainOwnerGraceMs: 0, tempRoot: root,
  })).resolves.toBe('done');
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner-a1.json'), '{truncated', { mode: 0o600 });
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => 'done', {
    run, randomPassword: () => 'temporary-password', keychainSearchLock: lock, keychainOwnerGraceMs: 0, tempRoot: root,
  })).rejects.toBeInstanceOf(AggregateError);
  await expect(stat(lock)).resolves.toBeDefined();
});

const notaryCredentials = { apiKeyPath: '/protected/AuthKey.p8', keyId: 'ABCDEFGHIJ', issuer: '12345678-1234-1234-1234-123456789abc', teamId: 'ABCDE12345' };
const submissionId = '12345678-1234-1234-1234-123456789abc';
const uploadSha = createHash('sha256').update('stable-upload').digest('hex');

async function signedAppFixture(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  const app = path.join(root, 'XR Collector.app');
  await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(path.join(app, 'Contents/MacOS/XR Collector'), 'app');
  return { root, app, evidenceDirectory: path.join(root, 'evidence') };
}

/** Fake notary tools: `ditto -c` writes the upload ZIP and `stapler staple` adds a ticket to the App. */
function notaryRun(app: string, handlers: Record<string, (args: string[]) => unknown>, calls: string[] = []) {
  return vi.fn(async (_command: string, args: string[]) => {
    const name = args[0] === '-c' ? 'ditto' : `${args[0]} ${args[1]}`;
    calls.push(name);
    const handled = handlers[name] ? await handlers[name](args) : undefined;
    if (handled) return handled;
    if (name === 'ditto') await writeFile(args.at(-1)!, 'stable-upload');
    if (name === 'stapler staple') await writeFile(path.join(app, 'Contents/CodeResources'), 'ticket');
    return { stdout: '', stderr: '' };
  });
}

const acceptedHandlers = (logIssues: unknown = []) => ({
  'notarytool submit': () => ({ stdout: JSON.stringify({ id: submissionId, status: 'In Progress' }), stderr: '' }),
  'notarytool wait': () => ({ stdout: JSON.stringify({ id: submissionId, status: 'Accepted' }), stderr: '' }),
  'notarytool log': async (args: string[]) => {
    await writeFile(args.at(-1)!, JSON.stringify({ jobId: submissionId, status: 'Accepted', sha256: uploadSha, issues: logIssues }));
    return { stdout: '', stderr: '' };
  },
});

it('notarizes the zipped App once, staples the App and records the stapled identity', async () => {
  const { app, evidenceDirectory } = await signedAppFixture('xr-app-notary-');
  const calls: string[] = [];
  const receipt = await notarizeAndStaple({ kind: 'app', artifactPath: app, credentials: notaryCredentials, evidenceDirectory }, {
    run: notaryRun(app, acceptedHandlers(), calls), describeStableCodeIdentity,
  });
  expect(calls).toEqual(['ditto', 'notarytool submit', 'notarytool wait', 'notarytool log', 'stapler staple', 'stapler validate']);
  expect(receipt).toMatchObject({ schemaVersion: 1, kind: 'app', teamId: 'ABCDE12345', submissionId, status: 'Accepted', issues: 0,
    submitted: { bytes: 'stable-upload'.length, sha256: uploadSha }, stapled: await describeArtifact(app), stapleValidated: true });
  expect(receipt).not.toHaveProperty('coveredBy');
  expect(receipt).not.toHaveProperty('signed');
  expect(JSON.parse(await readFile(path.join(evidenceDirectory, 'app-completed.json'), 'utf8'))).toEqual(receipt);
});

it('persists the App upload and submission before waiting so a resumed run reuses the same submission', async () => {
  const { app, evidenceDirectory } = await signedAppFixture('xr-app-notary-resume-');
  let submittedPath = '';
  await expect(notarizeAndStaple({ kind: 'app', artifactPath: app, credentials: notaryCredentials, evidenceDirectory }, { run: notaryRun(app, {
    ...acceptedHandlers(),
    'notarytool submit': (args) => { submittedPath = args[2]!; return { stdout: JSON.stringify({ id: submissionId, status: 'In Progress' }), stderr: '' }; },
    'notarytool wait': () => { throw new Error('temporary Apple queue timeout'); },
  }), describeStableCodeIdentity })).rejects.toThrow(/queue timeout/u);
  expect(await readFile(submittedPath, 'utf8')).toBe('stable-upload');
  const [receiptName] = (await readdir(evidenceDirectory)).filter((name) => name.endsWith('-submission.json'));
  expect(JSON.parse(await readFile(path.join(evidenceDirectory, receiptName!), 'utf8'))).toMatchObject({ kind: 'app', submissionId, status: 'In Progress' });

  const calls: string[] = [];
  await expect(notarizeAndStaple({ kind: 'app', artifactPath: app, credentials: notaryCredentials, evidenceDirectory }, { run: notaryRun(app, {
    ...acceptedHandlers(),
    ditto: () => { throw new Error('must reuse the persisted upload'); },
    'notarytool submit': () => { throw new Error('must not submit the same bytes twice'); },
  }, calls), describeStableCodeIdentity })).resolves.toMatchObject({ submissionId, status: 'Accepted', issues: 0, stapleValidated: true });
  expect(calls).not.toContain('ditto');
  expect(calls).not.toContain('notarytool submit');
});

async function signedDmgFixture(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  const dmg = path.join(root, 'XR-Collector-0.1.0-mac-arm64.dmg');
  await writeFile(dmg, 'stable-upload');
  return { dmg, evidenceDirectory: path.join(root, 'evidence') };
}

/** `stapler staple` on a DMG appends the ticket to the image file. */
const dmgStaple = (dmg: string) => ({ 'stapler staple': async () => { await writeFile(dmg, 'stable-upload+ticket'); return { stdout: '', stderr: '' }; } });

it('notarizes the DMG as itself without a ZIP upload, staples it and records the stapled DMG identity', async () => {
  const { dmg, evidenceDirectory } = await signedDmgFixture('xr-dmg-notary-');
  const calls: string[] = [];
  let submittedPath = '';
  const receipt = await notarizeAndStaple({ kind: 'dmg', artifactPath: dmg, credentials: notaryCredentials, evidenceDirectory }, {
    run: notaryRun(dmg, { ...acceptedHandlers(), ...dmgStaple(dmg),
      'notarytool submit': (args) => { submittedPath = args[2]!; return { stdout: JSON.stringify({ id: submissionId, status: 'In Progress' }), stderr: '' }; } }, calls),
    describeStableCodeIdentity,
  });
  expect(calls).toEqual(['notarytool submit', 'notarytool wait', 'notarytool log', 'stapler staple', 'stapler validate']);
  expect(submittedPath).toBe(dmg);
  expect(receipt).toMatchObject({ schemaVersion: 1, kind: 'dmg', teamId: 'ABCDE12345', submissionId, status: 'Accepted', issues: 0,
    submitted: { bytes: 'stable-upload'.length, sha256: uploadSha }, stapleValidated: true });
  expect(receipt.stapled).toEqual(await describeArtifact(dmg));
  expect(receipt.stapled).not.toEqual(receipt.submitted);
  expect(JSON.parse(await readFile(path.join(evidenceDirectory, 'dmg-completed.json'), 'utf8'))).toEqual(receipt);
});

it('persists the DMG submission before waiting so a resumed run reuses the same submission', async () => {
  const { dmg, evidenceDirectory } = await signedDmgFixture('xr-dmg-notary-resume-');
  await expect(notarizeAndStaple({ kind: 'dmg', artifactPath: dmg, credentials: notaryCredentials, evidenceDirectory }, { run: notaryRun(dmg, {
    ...acceptedHandlers(),
    'notarytool wait': () => { throw new Error('temporary Apple queue timeout'); },
  }), describeStableCodeIdentity })).rejects.toThrow(/queue timeout/u);
  expect(JSON.parse(await readFile(path.join(evidenceDirectory, `dmg-${uploadSha}-submission.json`), 'utf8'))).toMatchObject({ kind: 'dmg', submissionId, status: 'In Progress' });

  const calls: string[] = [];
  await expect(notarizeAndStaple({ kind: 'dmg', artifactPath: dmg, credentials: notaryCredentials, evidenceDirectory }, { run: notaryRun(dmg, {
    ...acceptedHandlers(), ...dmgStaple(dmg),
    'notarytool submit': () => { throw new Error('must not submit the same bytes twice'); },
  }, calls), describeStableCodeIdentity })).resolves.toMatchObject({ kind: 'dmg', submissionId, status: 'Accepted', issues: 0, stapleValidated: true });
  expect(calls).toEqual(['notarytool wait', 'notarytool log', 'stapler staple', 'stapler validate']);
  await expect(notarizeAndStaple({ kind: 'pkg', artifactPath: dmg, credentials: notaryCredentials, evidenceDirectory }))
    .rejects.toThrow(/Unsupported notarization kind pkg/u);
});

it('runs stapler validate, syspolicy_check and spctl execute on a stapled App', async () => {
  const gates = async (options: object = {}) => {
    const calls: string[] = [];
    await validateNotarizedApplication('/candidate/XR Collector.app', { ...options, run: async (command: string, args: string[]) => {
      calls.push(`${path.basename(command)} ${args[0] === '--assess' ? args.slice(0, 3).join(' ') : args[0]}`);
      return { stdout: '', stderr: '' };
    } });
    return calls;
  };
  expect(await gates()).toEqual(['xcrun stapler', 'syspolicy_check distribution', 'spctl --assess --type execute']);
  expect(await gates({ stapleValidated: true })).toEqual(['syspolicy_check distribution', 'spctl --assess --type execute']);
});

it('accepts Apple Accepted logs with null issues but rejects missing or malformed issue fields', async () => {
  const attempt = async (name: string, log: object) => {
    const { app, evidenceDirectory } = await signedAppFixture(`xr-notary-issues-${name}-`);
    const run = notaryRun(app, { ...acceptedHandlers(), 'notarytool log': async (args) => {
      await writeFile(args.at(-1)!, JSON.stringify({ jobId: submissionId, status: 'Accepted', sha256: uploadSha, ...log }));
      return { stdout: '', stderr: '' };
    } });
    return { app, evidenceDirectory, result: notarizeAndStaple({ kind: 'app', artifactPath: app, credentials: notaryCredentials, evidenceDirectory }, { run, describeStableCodeIdentity }) };
  };
  await expect((await attempt('null', { issues: null })).result).resolves.toMatchObject({ status: 'Accepted', issues: 0 });
  await expect((await attempt('missing', {})).result).rejects.toThrow(/Accepted, issue-free log/u);
  await expect((await attempt('malformed', { issues: { count: 0 } })).result).rejects.toThrow(/Accepted, issue-free log/u);
  const wrongSha = await attempt('wrong-sha', { issues: [], sha256: '0'.repeat(64) });
  await expect(wrongSha.result).rejects.toThrow(/Accepted, issue-free log/u);
  await expect(notarizeAndStaple({ kind: 'app', artifactPath: wrongSha.app, credentials: notaryCredentials, evidenceDirectory: wrongSha.evidenceDirectory }, {
    describeStableCodeIdentity, run: notaryRun(wrongSha.app, { 'notarytool submit': () => { throw new Error('fresh submit required after invalid log'); } }),
  })).rejects.toThrow(/failed full log validation and cannot be resumed/u);
});

it('resumes the same notarization receipt after stapling when validation was interrupted', async () => {
  const { app, evidenceDirectory } = await signedAppFixture('xr-notary-stapled-resume-');
  await expect(notarizeAndStaple({ kind: 'app', artifactPath: app, credentials: notaryCredentials, evidenceDirectory }, {
    run: notaryRun(app, acceptedHandlers(null)), describeStableCodeIdentity, afterStaple: async () => { throw new Error('interrupted immediately after staple'); },
  })).rejects.toThrow(/interrupted immediately after staple/u);
  const calls: string[] = [];
  const second = notaryRun(app, Object.fromEntries(['ditto', 'notarytool submit', 'notarytool wait', 'notarytool log', 'stapler staple']
    .map((name) => [name, () => { throw new Error('must resume completed receipt'); }])), calls);
  await expect(notarizeAndStaple({ kind: 'app', artifactPath: app, credentials: notaryCredentials, evidenceDirectory }, { run: second, describeStableCodeIdentity }))
    .resolves.toMatchObject({ submissionId, stapled: await describeArtifact(app), stapleValidated: true });
  expect(calls).toEqual(['stapler validate']);
});

it.skipIf(process.platform === 'win32')('repairs the embedded Python framework and signs staged runtime code inside-out without changing raw sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-runtime-signing-'));
  roots.push(root);
  const sourceBin = path.join(root, 'source');
  const appBin = path.join(root, 'XR.app/Contents/Resources/bin');
  const runtimeFiles = new Map<string, Buffer>([
    ['yt-dlp/yt-dlp', machO('yt')],
    ['yt-dlp/_internal/Python.framework/Versions/3.14/Python', machO('python')],
    ['yt-dlp/_internal/Python.framework/Versions/3.14/Resources/Info.plist', Buffer.from('plist')],
    ['deno', machO('deno')],
  ]);
  for (const base of [sourceBin, appBin]) {
    for (const [relative, bytes] of runtimeFiles) {
      await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
      await writeFile(path.join(base, relative), bytes, { mode: 0o755 });
    }
    for (const [relative, bytes] of [['meilisearch', machO('meili')], ['xr-mac-update-helper', machO('helper')]] as const) await writeFile(path.join(base, relative), bytes, { mode: 0o755 });
  }
  const pins = JSON.parse(await readFile('scripts/runtime-dependency-pins.json', 'utf8')).targets['darwin-arm64'];
  const identity = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const dependencies = {
    schemaVersion: 1, target: 'darwin-arm64',
    dependencies: {
      ytDlp: { version: pins.ytDlp.version, url: pins.ytDlp.url, archiveSha256: pins.ytDlp.sha256 },
      deno: { version: pins.deno.version, url: pins.deno.url, archiveSha256: pins.deno.sha256 },
    },
    executables: { ytDlp: pins.ytDlp.installedExecutable, deno: pins.deno.installedExecutable },
    files: [...runtimeFiles].map(([relative, bytes]) => ({ path: relative, ...identity(bytes) })).sort((left, right) => left.path.localeCompare(right.path)),
  };
  const meiliIdentity = identity(machO('meili'));
  const meili = { binary: meiliIdentity };
  for (const base of [sourceBin, appBin]) {
    await writeFile(path.join(base, 'runtime-dependencies.json'), JSON.stringify(dependencies));
    await writeFile(path.join(base, 'meilisearch-build.json'), JSON.stringify(meili));
  }
  const signCalls: string[] = [];
  const finishedSigns: string[] = [];
  let signsInFlight = 0;
  let maxSignsInFlight = 0;
  let leavesFinishedBeforeFramework = -1;
  const reconstructRuntimeDependencies = async ({ outputDir }: { outputDir: string }) => {
    for (const [relative, bytes] of runtimeFiles) {
      await mkdir(path.dirname(path.join(outputDir, relative)), { recursive: true });
      await writeFile(path.join(outputDir, relative), bytes, { mode: 0o755 });
    }
    await writeFile(path.join(outputDir, 'runtime-dependencies.json'), JSON.stringify(dependencies));
  };
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === '--force') {
      signCalls.push(args.at(-1)!);
      if (args.at(-1)!.endsWith('Python.framework')) leavesFinishedBeforeFramework = finishedSigns.length;
      signsInFlight += 1;
      maxSignsInFlight = Math.max(maxSignsInFlight, signsInFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      signsInFlight -= 1;
      finishedSigns.push(args.at(-1)!);
    }
    const target = args.at(-1)!;
    const team = target.endsWith('/deno') ? '2H4KBF436B' : 'ABCDE12345';
    return { stdout: args[0] === '-d' ? '<dict><key>com.apple.security.cs.allow-dyld-environment-variables</key><true/><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-executable-page-protection</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict>' : '', stderr: args[0] === '-dv'
      ? `Authority=Developer ID Application: Example (${team})\nTeamIdentifier=${team}\nCodeDirectory=v=20500 flags=0x10000(runtime)\nTimestamp=Oct 28, 2026\n`
      : '' };
  });
  const signed = await signStagedMacRuntimes({ appPath: path.join(root, 'XR.app'), sourceBin, identitySha1: 'A'.repeat(40), expectedTeamId: 'ABCDE12345', keychain: '/tmp/keychain' }, { run, prepareRuntimeDependencies: reconstructRuntimeDependencies });
  expect(signCalls.at(-1)).toBe(path.join(appBin, 'yt-dlp/_internal/Python.framework'));
  // Leaf files are signed concurrently; the framework starts only after every leaf has finished.
  expect(maxSignsInFlight).toBe(4);
  expect(leavesFinishedBeforeFramework).toBe(4);
  expect(signCalls.slice(0, -1).sort()).toEqual(['meilisearch', 'xr-mac-update-helper', 'yt-dlp/_internal/Python.framework/Versions/3.14/Python', 'yt-dlp/yt-dlp']
    .map((relative) => path.join(appBin, relative)).sort());
  expect(Object.keys(signed.executableSignatures)).toEqual([...signCalls.slice(0, -1).map((file) => path.relative(appBin, file)), 'yt-dlp/_internal/Python.framework', 'deno']);
  expect(await readlink(path.join(appBin, 'yt-dlp/_internal/Python.framework/Versions/Current'))).toBe('3.14');
  expect(await readlink(path.join(appBin, 'yt-dlp/_internal/Python.framework/Python'))).toBe('Versions/Current/Python');
  expect(signed).toMatchObject({ policy: 'developer-id-notarized', expectedAppTeamId: 'ABCDE12345', meilisearch: { source: meiliIdentity } });
  await expect(verifySignedRuntimeInventory(appBin, 'ABCDE12345', { run })).resolves.toMatchObject({ expectedAppTeamId: 'ABCDE12345' });
  await expect(verifySignedRuntimeInventory(appBin, 'ABCDE12345', { run: async (command: string, args: string[]) => {
    const result = await run(command, args);
    return args[0] === '-d' ? { stdout: '<dict><key>com.apple.security.cs.allow-jit</key><true/></dict>', stderr: '' } : result;
  } })).rejects.toThrow(/pinned five-key policy/u);
  expect(await readFile(path.join(sourceBin, 'meilisearch'))).toEqual(machO('meili'));

  const tamperedBytes = machO('tampered-yt');
  await writeFile(path.join(sourceBin, 'yt-dlp/yt-dlp'), tamperedBytes, { mode: 0o755 });
  const tamperedManifest = structuredClone(dependencies);
  Object.assign(tamperedManifest.files.find((entry) => entry.path === 'yt-dlp/yt-dlp')!, identity(tamperedBytes));
  await writeFile(path.join(sourceBin, 'runtime-dependencies.json'), JSON.stringify(tamperedManifest));
  const tamperedApp = path.join(root, 'Tampered.app');
  await cp(sourceBin, path.join(tamperedApp, 'Contents/Resources/bin'), { recursive: true });
  await expect(signStagedMacRuntimes({ appPath: tamperedApp, sourceBin, identitySha1: 'A'.repeat(40), expectedTeamId: 'ABCDE12345', keychain: '/tmp/keychain' }, {
    run, prepareRuntimeDependencies: reconstructRuntimeDependencies,
  })).rejects.toThrow(/independent extraction of the hash-pinned archives/u);
});

it('bounds concurrent work, keeps results in item order and stops starting work after a failure', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const started: number[] = [];
  const items = Array.from({ length: 20 }, (_, index) => index);
  const worker = async (item: number) => {
    started.push(item);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    if (item === 2) throw new Error('codesign failed for item 2');
    return item * 2;
  };
  expect(RUNTIME_SIGNING_CONCURRENCY).toBe(8);
  await expect(mapConcurrent([0, 1, 3, 4, 5, 6, 7, 8, 9, 10], RUNTIME_SIGNING_CONCURRENCY, worker)).resolves.toEqual([0, 2, 6, 8, 10, 12, 14, 16, 18, 20]);
  expect(maxInFlight).toBe(8);
  started.length = 0;
  await expect(mapConcurrent(items, RUNTIME_SIGNING_CONCURRENCY, worker)).rejects.toThrow(/item 2/u);
  expect(inFlight).toBe(0);
  expect(started.length).toBeLessThan(items.length);
  await expect(mapConcurrent([], RUNTIME_SIGNING_CONCURRENCY, worker)).resolves.toEqual([]);
});

it('requires the selected certificate and the stapled DMG to match the expected Team and a notarized Gatekeeper source', async () => {
  expect(() => selectDeveloperIdIdentity(`  1) ${'A'.repeat(40)} "Developer ID Application: Other (ZZZZZ99999)"`, 'ABCDE12345')).toThrow(/found 0/u);
  const dmgRun = (source: string) => vi.fn(async (command: string, args: string[]) => {
    if (args[0] === '-dv') return { stdout: '', stderr: 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nTimestamp=Oct 28, 2026\n' };
    if (path.basename(command) === 'spctl') return { stdout: '', stderr: `/candidate/XR.dmg: accepted\nsource=${source}\n` };
    return { stdout: '', stderr: '' };
  });
  const run = dmgRun('Notarized Developer ID');
  await expect(verifyDeveloperIdDiskImage('/candidate/XR.dmg', 'ABCDE12345', { run })).resolves.toEqual({
    signature: expect.objectContaining({ teamId: 'ABCDE12345' }),
    gatekeeper: { source: 'Notarized Developer ID', output: 'XR.dmg: accepted\nsource=Notarized Developer ID' },
  });
  expect(run.mock.calls.map(([command, args]) => `${path.basename(command)} ${args[0]}`)).toEqual(['xcrun stapler', 'codesign --verify', 'codesign -dv', 'spctl --assess']);
  expect(run.mock.calls.at(-1)![1]).toEqual(['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', '/candidate/XR.dmg']);
  const validatedRun = dmgRun('Notarized Developer ID');
  await verifyDeveloperIdDiskImage('/candidate/XR.dmg', 'ABCDE12345', { run: validatedRun, stapleValidated: true });
  expect(validatedRun.mock.calls.map(([command, args]) => `${path.basename(command)} ${args[0]}`)).toEqual(['codesign --verify', 'codesign -dv', 'spctl --assess']);
  await expect(verifyDeveloperIdDiskImage('/candidate/XR.dmg', 'ABCDE12345', { run: dmgRun('Unnotarized Developer ID') }))
    .rejects.toThrow(/source is Unnotarized Developer ID, not Notarized Developer ID/u);
  await expect(verifyDeveloperIdDiskImage('/candidate/XR.dmg', 'ABCDE12345', { run: async (command: string, args: string[]) => {
    if (path.basename(command) === 'spctl') throw new Error('spctl exited with status 3');
    return run(command, args);
  } })).rejects.toThrow(/status 3/u);
  expect(signedBuilderEnvironment({ PATH: '/tools' }, { keychain: '/tmp/keychain', identity: { sha1: 'A'.repeat(40) }, teamId: 'ABCDE12345', sourceRoot: '/source' }))
    .toEqual({ PATH: '/tools', CSC_KEYCHAIN: '/tmp/keychain', CSC_IDENTITY_AUTO_DISCOVERY: 'false', XR_MAC_SIGNING_IDENTITY_SHA1: 'A'.repeat(40), XR_MAC_SIGNING_TEAM_ID: 'ABCDE12345', XR_MAC_SIGNING_SOURCE_ROOT: '/source' });
});

it('requires a hardened outer App, safe JIT entitlements, sealed runtime inventory, and matching Team', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-app-signature-'));
  roots.push(root);
  const app = path.join(root, 'XR Collector.app');
  const bin = path.join(app, 'Contents/Resources/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'meilisearch'), machO('meili'), { mode: 0o755 });
  await writeFile(path.join(bin, 'runtime-dependencies.json'), '{}');
  const raw = { bytes: machO('meili').length, sha256: createHash('sha256').update(machO('meili')).digest('hex') };
  await writeFile(path.join(bin, 'meilisearch-build.json'), JSON.stringify({ binary: raw }));
  const entry = async (relative: string) => {
    const file = path.join(bin, relative); const bytes = await readFile(file);
    return { path: relative, type: 'file', mode: (await stat(file)).mode & 0o777, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const files = await Promise.all(['meilisearch', 'meilisearch-build.json', 'runtime-dependencies.json'].map(entry));
  files.sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(path.join(bin, 'runtime-signing.json'), JSON.stringify({
    schemaVersion: 1, policy: 'developer-id-notarized', expectedAppTeamId: 'ABCDE12345',
    sourceIdentity: { dependencyManifest: files.find((file) => file.path === 'runtime-dependencies.json'), meilisearchManifest: files.find((file) => file.path === 'meilisearch-build.json') },
    meilisearch: { source: raw, final: raw }, files, executableSignatures: {},
  }));
  const signature = 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nCodeDirectory=v=20500 flags=0x10000(runtime)\nTimestamp=Oct 28, 2026\n';
  const safeRun = async (_command: string, args: string[]) => ({ stdout: args[0] === '-d' ? '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>' : '', stderr: args[0] === '-dv' ? signature : '' });
  await expect(verifyDeveloperIdApplication(app, 'ABCDE12345', { run: safeRun, verifySignatures: false })).resolves.toMatchObject({ signature: { teamId: 'ABCDE12345' } });
  await expect(verifyDeveloperIdApplication(app, 'ABCDE12345', { run: async (command: string, args: string[]) => {
    const result = await safeRun(command, args);
    return args[0] === '-d' ? { stdout: '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.application-groups</key><array><string>unexpected</string></array></dict></plist>', stderr: '' } : result;
  }, verifySignatures: false })).rejects.toThrow(/unexpected entitlements/u);
});

function machO(label: string): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.write(label, 8);
  return bytes;
}

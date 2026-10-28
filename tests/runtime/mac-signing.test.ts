import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  loadMacSigningConfiguration, notarizeAndStaple, parseProtectedEnvironment, parseUserKeychainList, selectDeveloperIdIdentity, signStagedMacRuntimes,
  signedBuilderEnvironment, verifyDeveloperIdApplication, verifyDeveloperIdDiskImage, verifySignedRuntimeInventory, withTemporarySigningKeychain,
} from '../../scripts/mac-signing.mjs';

const roots: string[] = [];
const describeStableCodeIdentity = async () => ({ teamId: 'ABCDE12345', cdHash: 'a'.repeat(40), identifier: 'com.moneydj.xrcollector' });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

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

it('appends its keychain without reordering existing sessions and removes only its owned keychain', async () => {
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
  }, { run, randomPassword: () => 'temporary-password' })).resolves.toBe('done');
  const set = calls.find((args) => args[0] === 'list-keychains' && args[3] === '-s')!;
  expect(set.slice(4, -1)).toEqual(existingKeychains);
  expect(set.at(-1)).toMatch(/signing\.keychain-db$/u);
  expect(calls.filter((args) => args[0] === 'delete-keychain')).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'list-keychains' && args[3] === '-s')).toHaveLength(1);
  expect(keychains).toEqual([...existingKeychains, path.resolve('fixture/concurrent-session.keychain-db')]);
  expect(parseUserKeychainList(existingKeychains.map((entry) => `    ${JSON.stringify(entry)}`).join('\n'))).toEqual(existingKeychains);
});

it('preserves concurrent keychains and aggregates the work and owned-keychain deletion failures', async () => {
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
    }, { run, randomPassword: () => 'temporary-password' });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
    'Error: simulated signing failure', 'Error: simulated owned keychain deletion failure',
  ]);
  expect(keychains).toEqual([existing, concurrent]);
  expect(keychains).not.toContain(owned);
  expect(run.mock.calls.filter(([, args]) => args[0] === 'list-keychains' && args[3] === '-s')).toHaveLength(2);
});

it('reclaims only a shared keychain-list lock whose recorded owner process is gone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-stale-keychain-lock-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 424242, token: 'stale-owner' }));
  let keychains: string[] = [];
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    if (args[0] === 'delete-keychain') { keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => 'done', {
    run, randomPassword: () => 'temporary-password', keychainSearchLock: lock, isProcessAlive: () => false,
  })).resolves.toBe('done');
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reclaims ownerless or malformed shared locks only after their creation grace period', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-ownerless-keychain-lock-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  await mkdir(lock);
  let keychains: string[] = [];
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'list-keychains' && args[3] === '-s') { keychains = args.slice(4); return { stdout: '', stderr: '' }; }
    if (args[0] === 'list-keychains') return { stdout: keychains.map((entry) => JSON.stringify(entry)).join('\n'), stderr: '' };
    if (args[0] === 'find-identity') return { stdout: `1) ${'A'.repeat(40)} "Developer ID Application: Example (ABCDE12345)"`, stderr: '' };
    if (args[0] === 'delete-keychain') { keychains = keychains.filter((entry) => entry !== args[1]); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => 'done', {
    run, randomPassword: () => 'temporary-password', keychainSearchLock: lock, keychainOwnerGraceMs: 0,
  })).resolves.toBe('done');
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), '{truncated');
  await expect(withTemporarySigningKeychain({ certificatePath: '/protected/certificate.p12', certificatePassword: 'secret', teamId: 'ABCDE12345' }, async () => 'done', {
    run, randomPassword: () => 'temporary-password', keychainSearchLock: lock, keychainOwnerGraceMs: 0,
  })).resolves.toBe('done');
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps notarization resumable by persisting the submission before waiting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-notary-resume-'));
  roots.push(root);
  const artifact = path.join(root, 'XR Collector.dmg');
  const evidenceDirectory = path.join(root, 'evidence');
  await writeFile(artifact, 'dmg');
  const credentials = { apiKeyPath: '/protected/AuthKey.p8', keyId: 'ABCDEFGHIJ', issuer: '12345678-1234-1234-1234-123456789abc', teamId: 'ABCDE12345' };
  const id = '12345678-1234-1234-1234-123456789abc';
  const first = vi.fn(async (_command: string, args: string[]) => {
    if (args[1] === 'submit') return { stdout: JSON.stringify({ id, status: 'In Progress' }), stderr: '' };
    if (args[1] === 'wait') throw new Error('temporary Apple queue timeout');
    return { stdout: '', stderr: '' };
  });
  await expect(notarizeAndStaple({ kind: 'dmg', artifactPath: artifact, credentials, evidenceDirectory }, { run: first, describeStableCodeIdentity }))
    .rejects.toThrow(/queue timeout/u);
  const [receiptName] = (await readdir(evidenceDirectory)).filter((name) => name.endsWith('-submission.json'));
  expect(JSON.parse(await readFile(path.join(evidenceDirectory, receiptName!), 'utf8'))).toMatchObject({ submissionId: id, status: 'In Progress' });

  const second = vi.fn(async (_command: string, args: string[]) => {
    if (args[1] === 'submit') throw new Error('must not submit the same bytes twice');
    if (args[1] === 'wait') return { stdout: JSON.stringify({ id, status: 'Accepted' }), stderr: '' };
    if (args[1] === 'log') {
      await writeFile(args.at(-1)!, JSON.stringify({ jobId: id, status: 'Accepted', sha256: createHash('sha256').update('dmg').digest('hex'), issues: [] }));
    }
    return { stdout: '', stderr: '' };
  });
  await expect(notarizeAndStaple({ kind: 'dmg', artifactPath: artifact, credentials, evidenceDirectory }, { run: second, describeStableCodeIdentity }))
    .resolves.toMatchObject({ submissionId: id, status: 'Accepted', issues: 0, stapleValidated: true });
  expect(second.mock.calls.some(([, args]) => args[1] === 'submit')).toBe(false);
});

it('persists the exact App upload archive so a queued submission can resume by the same SHA', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-app-notary-resume-'));
  roots.push(root);
  const app = path.join(root, 'XR Collector.app');
  const evidenceDirectory = path.join(root, 'evidence');
  await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(path.join(app, 'Contents/MacOS/XR Collector'), 'app');
  const credentials = { apiKeyPath: '/protected/AuthKey.p8', keyId: 'ABCDEFGHIJ', issuer: '12345678-1234-1234-1234-123456789abc', teamId: 'ABCDE12345' };
  const id = '12345678-1234-1234-1234-123456789abc';
  let dittoCount = 0;
  let submittedPath = '';
  const first = async (_command: string, args: string[]) => {
    if (args[0] === '-c') { dittoCount += 1; await writeFile(args.at(-1)!, 'stable-upload'); return { stdout: '', stderr: '' }; }
    if (args[1] === 'submit') { submittedPath = args[2]!; return { stdout: JSON.stringify({ id, status: 'In Progress' }), stderr: '' }; }
    if (args[1] === 'wait') throw new Error('queue timeout');
    return { stdout: '', stderr: '' };
  };
  await expect(notarizeAndStaple({ kind: 'app', artifactPath: app, credentials, evidenceDirectory }, { run: first, describeStableCodeIdentity })).rejects.toThrow(/queue timeout/u);
  expect(await readFile(submittedPath, 'utf8')).toBe('stable-upload');
  await expect(notarizeAndStaple({ kind: 'app', artifactPath: app, credentials, evidenceDirectory }, { run: async (_command: string, args: string[]) => {
    if (args[0] === '-c') { dittoCount += 1; throw new Error('must reuse upload'); }
    if (args[1] === 'submit') throw new Error('must reuse submission');
    if (args[1] === 'wait') return { stdout: JSON.stringify({ id, status: 'Accepted' }), stderr: '' };
    if (args[1] === 'log') await writeFile(args.at(-1)!, JSON.stringify({ jobId: id, status: 'Accepted', sha256: createHash('sha256').update('stable-upload').digest('hex'), issues: [] }));
    return { stdout: '', stderr: '' };
  }, describeStableCodeIdentity })).resolves.toMatchObject({ status: 'Accepted' });
  expect(dittoCount).toBe(1);
});

it('accepts Apple Accepted logs with null issues but rejects missing or malformed issue fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-notary-issues-'));
  roots.push(root);
  const artifact = path.join(root, 'XR Collector.dmg');
  await writeFile(artifact, 'dmg');
  const credentials = { apiKeyPath: '/protected/AuthKey.p8', keyId: 'ABCDEFGHIJ', issuer: '12345678-1234-1234-1234-123456789abc', teamId: 'ABCDE12345' };
  const id = '12345678-1234-1234-1234-123456789abc';
  const attempt = async (name: string, issues: unknown, includeIssues = true, submittedSha = createHash('sha256').update('dmg').digest('hex')) => notarizeAndStaple({
    kind: 'dmg', artifactPath: artifact, credentials, evidenceDirectory: path.join(root, name),
  }, { run: async (_command: string, args: string[]) => {
    if (args[1] === 'submit') return { stdout: JSON.stringify({ id, status: 'In Progress' }), stderr: '' };
    if (args[1] === 'wait') return { stdout: JSON.stringify({ id, status: 'Accepted' }), stderr: '' };
    if (args[1] === 'log') await writeFile(args.at(-1)!, JSON.stringify({ jobId: id, status: 'Accepted', sha256: submittedSha, ...(includeIssues ? { issues } : {}) }));
    return { stdout: '', stderr: '' };
  }, describeStableCodeIdentity });
  await expect(attempt('null', null)).resolves.toMatchObject({ status: 'Accepted', issues: 0 });
  await expect(attempt('missing', undefined, false)).rejects.toThrow(/Accepted, issue-free log/u);
  await expect(attempt('malformed', { count: 0 })).rejects.toThrow(/Accepted, issue-free log/u);
  await expect(attempt('wrong-sha', [], true, '0'.repeat(64))).rejects.toThrow(/Accepted, issue-free log/u);
  await expect(notarizeAndStaple({ kind: 'dmg', artifactPath: artifact, credentials, evidenceDirectory: path.join(root, 'wrong-sha') }, {
    describeStableCodeIdentity,
    run: async (_command: string, args: string[]) => {
      if (args[1] === 'submit') throw new Error('fresh submit required after invalid log');
      if (args[1] === 'validate') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  })).rejects.toThrow(/failed full log validation and cannot be resumed/u);
});

it('resumes the same notarization receipt after stapling when validation was interrupted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-notary-stapled-resume-'));
  roots.push(root);
  const artifact = path.join(root, 'XR Collector.dmg');
  const evidenceDirectory = path.join(root, 'evidence');
  await writeFile(artifact, 'dmg');
  const credentials = { apiKeyPath: '/protected/AuthKey.p8', keyId: 'ABCDEFGHIJ', issuer: '12345678-1234-1234-1234-123456789abc', teamId: 'ABCDE12345' };
  const id = '12345678-1234-1234-1234-123456789abc';
  const first = async (_command: string, args: string[]) => {
    if (args[1] === 'submit') return { stdout: JSON.stringify({ id, status: 'In Progress' }), stderr: '' };
    if (args[1] === 'wait') return { stdout: JSON.stringify({ id, status: 'Accepted' }), stderr: '' };
    if (args[1] === 'log') await writeFile(args.at(-1)!, JSON.stringify({ jobId: id, status: 'Accepted', sha256: createHash('sha256').update('dmg').digest('hex'), issues: null }));
    return { stdout: '', stderr: '' };
  };
  await expect(notarizeAndStaple({ kind: 'dmg', artifactPath: artifact, credentials, evidenceDirectory }, {
    run: first, describeStableCodeIdentity, afterStaple: async () => { throw new Error('interrupted immediately after staple'); },
  })).rejects.toThrow(/interrupted immediately after staple/u);
  const second = vi.fn(async (_command: string, args: string[]) => {
    if (['submit', 'wait', 'log', 'staple'].includes(args[1]!)) throw new Error('must resume completed receipt');
    return { stdout: '', stderr: '' };
  });
  await expect(notarizeAndStaple({ kind: 'dmg', artifactPath: artifact, credentials, evidenceDirectory }, { run: second, describeStableCodeIdentity })).resolves.toMatchObject({ submissionId: id, stapleValidated: true });
  expect(second).toHaveBeenCalledTimes(1);
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
  const reconstructRuntimeDependencies = async ({ outputDir }: { outputDir: string }) => {
    for (const [relative, bytes] of runtimeFiles) {
      await mkdir(path.dirname(path.join(outputDir, relative)), { recursive: true });
      await writeFile(path.join(outputDir, relative), bytes, { mode: 0o755 });
    }
    await writeFile(path.join(outputDir, 'runtime-dependencies.json'), JSON.stringify(dependencies));
  };
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === '--force') signCalls.push(args.at(-1)!);
    const target = args.at(-1)!;
    const team = target.endsWith('/deno') ? '2H4KBF436B' : 'ABCDE12345';
    return { stdout: args[0] === '-d' ? '<dict><key>com.apple.security.cs.allow-dyld-environment-variables</key><true/><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-executable-page-protection</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict>' : '', stderr: args[0] === '-dv'
      ? `Authority=Developer ID Application: Example (${team})\nTeamIdentifier=${team}\nCodeDirectory=v=20500 flags=0x10000(runtime)\nTimestamp=Oct 28, 2026\n`
      : '' };
  });
  const signed = await signStagedMacRuntimes({ appPath: path.join(root, 'XR.app'), sourceBin, identitySha1: 'A'.repeat(40), expectedTeamId: 'ABCDE12345', keychain: '/tmp/keychain' }, { run, prepareRuntimeDependencies: reconstructRuntimeDependencies });
  expect(signCalls.at(-1)).toBe(path.join(appBin, 'yt-dlp/_internal/Python.framework'));
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

it('requires the selected certificate and final DMG to match the expected Team', async () => {
  expect(() => selectDeveloperIdIdentity(`  1) ${'A'.repeat(40)} "Developer ID Application: Other (ZZZZZ99999)"`, 'ABCDE12345')).toThrow(/found 0/u);
  const run = vi.fn(async (_command: string, args: string[]) => ({ stdout: '', stderr: args[0] === '-dv'
    ? 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nTimestamp=Oct 28, 2026\n' : '' }));
  await expect(verifyDeveloperIdDiskImage('/candidate/XR.dmg', 'ABCDE12345', { run })).resolves.toMatchObject({ teamId: 'ABCDE12345' });
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

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error The build doctor is intentionally executable JavaScript.
import { assertBuildEnvironment, checkBuildEnvironment, formatResults, hostBuildTarget } from '../../scripts/build-doctor.mjs';

type Responses = Record<string, string | Error>;

const MAC_HOST = { platform: 'darwin', processArch: 'arm64', hostArch: 'arm64', emulated: false };
const WINDOWS_HOST = { platform: 'win32', processArch: 'x64', hostArch: 'x64', emulated: false };
async function checkout({ nvmrc = '22.22.3', installed = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-build-doctor-test-'));
  await writeFile(path.join(root, '.nvmrc'), `${nvmrc}\n`);
  if (installed) {
    for (const file of ['node_modules/electron/package.json', 'node_modules/electron-builder/cli.js']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), '');
    }
  }
  return root;
}

function machine(responses: Responses) {
  return async (command: string, args: string[]) => {
    const key = [path.win32.basename(command), ...args].join(' ');
    const response = responses[key];
    if (response === undefined || response instanceof Error) throw response ?? new Error(`unexpected command ${key}`);
    return { stdout: response, stderr: '' };
  };
}

const MAC_TOOLS: Responses = {
  'git --version': 'git version 2.50.1\n',
  'xcrun --find swiftc': '/usr/bin/swiftc\n',
};
const WINDOWS_TOOLS: Responses = {
  'git --version': 'git version 2.45.0.windows.1\n',
};

async function check(target: string, options: { host?: object; tools?: Responses; nodeVersion?: string; root?: string; report?: boolean; overrides?: object } = {}) {
  const root = options.root ?? await checkout();
  return checkBuildEnvironment({ target, report: options.report ?? false }, {
    projectRoot: root,
    run: machine(options.tools ?? (target === 'win32-x64' ? WINDOWS_TOOLS : MAC_TOOLS)),
    probePhysicalHost: async () => options.host ?? (target === 'win32-x64' ? WINDOWS_HOST : MAC_HOST),
    nodeVersion: options.nodeVersion ?? '22.22.3',
    environment: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js', npm_config_user_agent: 'npm/10.9.4 node/v22.22.3' },
    access: async (file: string) => { if (file.endsWith('.env')) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    ...options.overrides,
  });
}

const byLabel = (results: any[], prefix: string) => results.find((result) => result.label.startsWith(prefix));
const statuses = (results: any[]) => Object.fromEntries(results.map((result) => [result.label, result.status]));

it('picks the native package target of the build machine and rejects other platforms', () => {
  expect(hostBuildTarget('darwin')).toBe('darwin-arm64');
  expect(hostBuildTarget('win32')).toBe('win32-x64');
  expect(() => hostBuildTarget('linux')).toThrow(/macOS \(Apple Silicon\) or Windows x64/u);
});

it('passes a ready Mac with Git and swiftc, and a ready Windows machine with only Git', async () => {
  expect(statuses(await check('darwin-arm64'))).toEqual({
    Host: 'ok', Node: 'ok', npm: 'ok', Git: 'ok', 'npm dependencies': 'ok', 'Xcode Command Line Tools': 'ok',
  });
  expect(statuses(await check('win32-x64'))).toEqual({
    Host: 'ok', Node: 'ok', npm: 'ok', Git: 'ok', 'npm dependencies': 'ok',
  });
});

it('requires swiftc on a Mac and Git everywhere', async () => {
  expect(byLabel(await check('darwin-arm64', { tools: { ...MAC_TOOLS, 'xcrun --find swiftc': new Error('no developer tools') } }), 'Xcode'))
    .toMatchObject({ status: 'missing', fix: 'xcode-select --install' });
  expect(byLabel(await check('win32-x64', { tools: { 'git --version': new Error('not found') } }), 'Git'))
    .toMatchObject({ status: 'missing', fix: expect.stringContaining('git-scm.com') });
});

it('fails a wrong Node major or architecture, notes a patch mismatch and accepts x64 emulation', async () => {
  expect(byLabel(await check('darwin-arm64', { nodeVersion: '24.1.0' }), 'Node')).toMatchObject({ status: 'missing', fix: 'nvm install 22.22.3 && nvm use 22.22.3' });
  expect(byLabel(await check('win32-x64', { nodeVersion: '22.22.0' }), 'Node')).toMatchObject({ status: 'note' });
  expect(byLabel(await check('darwin-arm64', { host: { ...MAC_HOST, processArch: 'x64', emulated: true } }), 'Host')).toMatchObject({ status: 'missing' });
  expect(byLabel(await check('win32-x64', { host: { ...WINDOWS_HOST, processArch: 'arm64' } }), 'Host')).toMatchObject({ status: 'missing' });
  expect(byLabel(await check('win32-x64', { host: { ...WINDOWS_HOST, hostArch: 'arm64', emulated: true } }), 'Host')).toMatchObject({ status: 'ok', detail: expect.stringContaining('emulated on arm64') });
  expect(byLabel(await check('win32-x64', { root: await checkout({ installed: false }) }), 'npm dependencies')).toMatchObject({ status: 'missing', fix: 'npm ci' });
});

it('stops packaging before any work with only the missing items', async () => {
  const dependencies = {
    projectRoot: await checkout(),
    run: machine({ 'git --version': 'git version 2.50.1\n', 'xcrun --find swiftc': new Error('no developer tools') }),
    probePhysicalHost: async () => MAC_HOST,
    nodeVersion: '22.22.3',
    environment: { npm_execpath: '/npm-cli.js' },
  };
  const failure = await assertBuildEnvironment({ target: 'darwin-arm64' }, dependencies).catch((error: Error) => error);
  expect(failure.message).toMatch(/cannot build darwin-arm64 packages yet/u);
  expect(failure.message).toContain('swiftc is unavailable');
  expect(failure.message).not.toContain('Git');
  expect(failure.message).toContain('npm run doctor:build');
});

it('reports the runtime cache and Mac signing state without failing on either', async () => {
  const prepared: string[] = [];
  const results = await check('darwin-arm64', {
    report: true,
    overrides: {
      prepareRuntimeDependencies: async ({ outputDir }: any) => { prepared.push(outputDir); },
      prepareMeilisearch: async () => { throw new Error('Meilisearch 1.53.2 for darwin-arm64 is missing from the runtime cache'); },
    },
  });
  expect(byLabel(results, 'Runtime cache')).toMatchObject({
    status: 'note', detail: 'not prepared: Meilisearch', fix: 'npm run prepare:runtime -- mac',
  });
  expect(prepared[0]).not.toContain(path.join('resources', 'bin'));
  expect(byLabel(results, 'Mac Developer ID')).toMatchObject({ status: 'note', detail: expect.stringContaining('ad-hoc') });

  const ready = await check('darwin-arm64', {
    report: true,
    overrides: {
      prepareRuntimeDependencies: async () => undefined,
      prepareMeilisearch: async () => undefined,
      access: async () => undefined,
      loadMacSigningConfiguration: async () => { throw new Error('Signing environment is missing APPLE_TEAM_ID.'); },
    },
  });
  expect(byLabel(ready, 'Runtime cache')).toMatchObject({ status: 'ok', detail: 'yt-dlp and Deno, Meilisearch prepared' });
  expect(byLabel(ready, 'Mac Developer ID')).toMatchObject({ status: 'missing', detail: 'Signing environment is missing APPLE_TEAM_ID.' });

  const windows = await check('win32-x64', {
    report: true,
    overrides: { prepareRuntimeDependencies: async () => undefined, prepareMeilisearch: async () => undefined },
  });
  expect(statuses(windows)).toEqual({
    Host: 'ok', Node: 'ok', npm: 'ok', Git: 'ok', 'npm dependencies': 'ok', 'Runtime cache': 'ok',
  });
});

it('prints each item with its fix', () => {
  expect(formatResults([
    { status: 'ok', label: 'Git', detail: '2.50.1' },
    { status: 'missing', label: 'Xcode Command Line Tools', detail: 'swiftc is unavailable', fix: 'xcode-select --install' },
    { status: 'note', label: 'Runtime cache', detail: 'not prepared: yt-dlp and Deno', fix: 'npm run prepare:runtime -- mac' },
  ])).toBe([
    '  ok      Git: 2.50.1',
    '  missing Xcode Command Line Tools: swiftc is unavailable',
    '          fix: xcode-select --install',
    '  note    Runtime cache: not prepared: yt-dlp and Deno',
    '          next: npm run prepare:runtime -- mac',
  ].join('\n'));
});

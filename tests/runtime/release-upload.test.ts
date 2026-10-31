import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { uploadRelease } from '../../scripts/release-upload.mjs';

const head = 'a'.repeat(40);
const repository = 'derektu/xr-collector-test';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const sha256 = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const httpError = (status: number) => Object.assign(new Error(`gh: HTTP ${status}`), { status });

interface Asset { id: number; name: string; state: string; body: Buffer }
interface Release { id: number; tag_name: string; draft: boolean; assets: Asset[] }

/** One platform's package output and an in-memory GitHub reached only through `gh` arguments. */
async function setup(target: 'darwin-arm64' | 'win32-x64', options: { version?: string; commit?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-release-upload-'));
  roots.push(root);
  const output = path.join(root, 'release');
  await mkdir(output);
  const version = options.version ?? '0.1.0';
  const commit = options.commit ?? head;
  const names = target === 'darwin-arm64'
    ? [`XR-Collector-${version}-mac-arm64.dmg`, `XR-Collector-${version}-mac-arm64.zip`]
    : [`XR-Collector-${version}-win-x64-setup.exe`];
  for (const name of names) await writeFile(path.join(output, name), `${name} bytes`);
  const entry = (name: string) => ({ name, bytes: Buffer.byteLength(`${name} bytes`), sha256: sha256(`${name} bytes`) });
  await writeFile(path.join(output, `release-${target}.json`), JSON.stringify({ schemaVersion: 1, version, commit, target, buildInfo: {},
    installer: entry(names[0]!), update: entry(names.at(-1)!) }));
  await writeFile(path.join(output, `XR-Collector-${version}-${target}-artifacts.json`), JSON.stringify({ commit,
    packageIdentity: { updateRepository: repository } }));

  const git = { status: '', head, localTag: null as string | null };
  const github = { tags: new Map<string, string>(), commits: new Set([head]), releases: [] as Release[], nextId: 1, calls: [] as string[][],
    corruptUpload: false, authError: null as Error | null };
  const exec = async (command: string, args: string[], { digest = false } = {}) => {
    if (command === 'git') {
      if (args[0] === 'status') return git.status;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${git.head}\n`;
      if (args[0] === 'rev-parse') { if (git.localTag) return `${git.localTag}\n`; throw Object.assign(new Error('git'), { notFound: true }); }
    }
    if (command !== 'gh') throw new Error(`unexpected ${command}`);
    github.calls.push(args);
    if (args[0] === 'auth') { if (github.authError) throw github.authError; return ''; }
    if (args[0] === 'release' && args[1] === 'upload') {
      const release = github.releases.find((entry) => entry.tag_name === args[2])!;
      for (const file of args.slice(3, args.indexOf('--repo'))) {
        const body = Buffer.concat([await readFile(file), Buffer.from(github.corruptUpload ? '!' : '')]);
        release.assets.push({ id: github.nextId++, name: path.basename(file), state: 'uploaded', body });
      }
      return '';
    }
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    const endpoint = args.find((arg) => arg.startsWith('repos/'))!.slice(`repos/${repository}/`.length);
    const field = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const json = (value: unknown) => JSON.stringify(value);
    const view = (release: Release) => ({ ...release, assets: release.assets.map(({ body: _body, ...asset }) => asset) });
    let match: RegExpExecArray | null;
    if ((match = /^git\/ref\/tags\/(.+)$/u.exec(endpoint))) {
      const sha = github.tags.get(match[1]!); if (!sha) throw httpError(404);
      return json({ object: { type: 'commit', sha } });
    }
    if (endpoint === 'git/refs' && method === 'POST') { github.tags.set(field('ref')!.slice('refs/tags/'.length), field('sha')!); return json({}); }
    if ((match = /^commits\/(.+)$/u.exec(endpoint))) { if (!github.commits.has(match[1]!)) throw httpError(422); return json({}); }
    if (endpoint.startsWith('releases?')) return json(github.releases.map(view));
    if (endpoint === 'releases' && method === 'POST') {
      const release = { id: github.nextId++, tag_name: field('tag_name')!, draft: true, assets: [] };
      github.releases.push(release); return json(view(release));
    }
    if ((match = /^releases\/assets\/(\d+)$/u.exec(endpoint))) {
      const asset = github.releases.flatMap((release) => release.assets).find((entry) => entry.id === Number(match![1]))!;
      return digest ? { bytes: asset.body.length, sha256: sha256(asset.body) } : asset.body.toString();
    }
    if ((match = /^releases\/(\d+)$/u.exec(endpoint))) return json(view(github.releases.find((release) => release.id === Number(match![1]))!));
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const upload = (tag = `v${version}`) => uploadRelease({ tag }, {
    root, exec, log: () => undefined, platform: target === 'darwin-arm64' ? 'darwin' : 'win32',
  });
  const uploads = () => github.calls.filter((call) => call[0] === 'release' && call[1] === 'upload');
  return { root, output, git, github, upload, uploads };
}

it('creates the tag and the draft, uploads one platform, and verifies it by downloading it back', async () => {
  const mac = await setup('darwin-arm64');
  await expect(mac.upload()).resolves.toMatchObject({ repository, tag: 'v0.1.0', platforms: ['darwin-arm64'],
    uploaded: ['XR-Collector-0.1.0-mac-arm64.dmg', 'XR-Collector-0.1.0-mac-arm64.zip', 'release-darwin-arm64.json'], skipped: [] });
  expect(mac.github.tags.get('v0.1.0')).toBe(head);
  expect(mac.github.releases).toHaveLength(1);
  expect(mac.github.releases[0]).toMatchObject({ draft: true });
  const downloads = mac.github.calls.filter((call) => call.some((arg) => arg.includes('/releases/assets/')));
  expect(downloads).toHaveLength(3);
});

it('adds a second platform to the same draft from another machine and skips files already there', async () => {
  const mac = await setup('darwin-arm64');
  await mac.upload();
  const windows = await setup('win32-x64');
  Object.assign(windows.github, { tags: mac.github.tags, releases: mac.github.releases, nextId: mac.github.nextId });
  await expect(windows.upload()).resolves.toMatchObject({ platforms: ['darwin-arm64', 'win32-x64'],
    uploaded: ['XR-Collector-0.1.0-win-x64-setup.exe', 'release-win32-x64.json'] });
  expect(windows.github.calls.some((call) => call.includes('--method') && call.some((arg) => arg.endsWith('/releases')))).toBe(false);
  await expect(windows.upload()).resolves.toMatchObject({ uploaded: [], skipped: ['XR-Collector-0.1.0-win-x64-setup.exe', 'release-win32-x64.json'] });
  expect(windows.uploads()).toHaveLength(1);
  expect(mac.github.releases[0]!.assets.map((asset) => asset.name).sort()).toEqual([
    'XR-Collector-0.1.0-mac-arm64.dmg', 'XR-Collector-0.1.0-mac-arm64.zip', 'XR-Collector-0.1.0-win-x64-setup.exe',
    'release-darwin-arm64.json', 'release-win32-x64.json',
  ]);
});

it('stops on a dirty checkout before reaching GitHub', async () => {
  const mac = await setup('darwin-arm64');
  mac.git.status = ' M src/main.ts\n';
  await expect(mac.upload()).rejects.toThrow(/uncommitted changes/u);
  expect(mac.github.calls).toEqual([]);
});

it('stops when HEAD is not the built commit, or a local or remote tag points elsewhere', async () => {
  const built = await setup('darwin-arm64', { commit: 'b'.repeat(40) });
  await expect(built.upload()).rejects.toThrow(/HEAD is a+, but the package was built from b+/u);
  const local = await setup('darwin-arm64');
  local.git.localTag = 'c'.repeat(40);
  await expect(local.upload()).rejects.toThrow(/local tag v0.1.0 points at c+/u);
  const remote = await setup('darwin-arm64');
  remote.github.tags.set('v0.1.0', 'd'.repeat(40));
  await expect(remote.upload()).rejects.toThrow(/tag v0.1.0 points at d+, not HEAD/u);
  const unpushed = await setup('darwin-arm64');
  unpushed.github.commits.clear();
  await expect(unpushed.upload()).rejects.toThrow(/does not have commit a+\. Push it/u);
  for (const run of [built, local, remote, unpushed]) expect(run.uploads()).toEqual([]);
  expect(unpushed.github.tags.size).toBe(0);
});

it('stops when a file does not match the platform index or the tag is not this version', async () => {
  const mac = await setup('darwin-arm64');
  await writeFile(path.join(mac.output, 'XR-Collector-0.1.0-mac-arm64.zip'), 'rebuilt bytes');
  await expect(mac.upload()).rejects.toThrow(/XR-Collector-0\.1\.0-mac-arm64\.zip does not match release-darwin-arm64\.json/u);
  await expect(mac.upload('v0.2.0')).rejects.toThrow(/version 0\.1\.0 for darwin-arm64, not 0\.2\.0/u);
  await expect(mac.upload('0.1.0')).rejects.toThrow(/must look like v0\.1\.0/u);
  expect(mac.github.calls).toEqual([]);
});

it('stops on a same-named file with other bytes in the draft, and on a published release', async () => {
  const mac = await setup('darwin-arm64');
  mac.github.tags.set('v0.1.0', head);
  mac.github.releases.push({ id: 90, tag_name: 'v0.1.0', draft: true,
    assets: [{ id: 91, name: 'XR-Collector-0.1.0-mac-arm64.zip', state: 'uploaded', body: Buffer.from('older build') }] });
  await expect(mac.upload()).rejects.toThrow(/already has a different XR-Collector-0\.1\.0-mac-arm64\.zip.*gh release delete-asset/u);
  mac.github.releases[0]!.draft = false;
  await expect(mac.upload()).rejects.toThrow(/already published/u);
  expect(mac.uploads()).toEqual([]);
});

it('fails when a downloaded file differs from what was uploaded', async () => {
  const windows = await setup('win32-x64');
  windows.github.corruptUpload = true;
  await expect(windows.upload()).rejects.toThrow(/does not match the local file after upload/u);
});

it('stops before GitHub changes when gh has no usable sign-in, keeping gh\'s own reason', async () => {
  const mac = await setup('darwin-arm64');
  mac.github.authError = new Error('gh auth status exited with 1: error connecting to api.github.com');
  await expect(mac.upload()).rejects.toThrow(/run gh auth login if it is missing\. .*error connecting to api\.github\.com/u);
  expect(mac.github.calls).toEqual([['auth', 'status', '--hostname', 'github.com']]);
});

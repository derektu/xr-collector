import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { exportVault, unpackVault } from '../../src/vault/vault-package.js';
import { VaultWorkspace } from '../../src/vault/workspace.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';
import { createHttpApp } from '../../src/server/app.js';
import type { CapturedTranscript, SavedDocument, TranscriptSearch } from '../../src/core/types.js';

const roots: string[] = [];
const workspaces: VaultWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-transfer-'));
  roots.push(root);
  return root;
}
const capture: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: '跨機搬移測試', channelId: 'UC123', channelTitle: '測試頻道', publishedAt: null,
  languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual',
  bodyMarkdown: '獨立森林觀測資料。\n\n![附件](../../attachments/sample.bin)',
};
async function seed(root: string) {
  await new MarkdownVault(root).add(capture);
  await new JsonChannelStore(root).add({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z' });
  await new JsonChannelScheduleStore(root).save({ enabled: true, intervalMinutes: 60,
    nextRunAt: '2099-01-01T00:00:00.000Z', lastAttemptAt: null, lastCompletedAt: null, lastResult: null });
  await mkdir(path.join(root, 'attachments'), { recursive: true });
  await writeFile(path.join(root, 'attachments/sample.bin'), Buffer.from([0, 1, 128, 255]));
  await mkdir(path.join(root, 'versions'), { recursive: true });
  await writeFile(path.join(root, 'versions/retained.md'), 'retained version');
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function packageOf(files: { path: string; data: string }[]) {
  const entries = files.map((file) => ({ path: file.path, data: Buffer.from(file.data).toString('base64'), size: Buffer.byteLength(file.data), sha256: sha(file.data) }));
  return Buffer.from(JSON.stringify({ format: 'xr-collector-vault', version: 1, files: entries,
    sha256: sha(JSON.stringify(entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })))) }));
}
function fakeSearch(root: string): TranscriptSearch {
  let docs: SavedDocument[] = [];
  return {
    status: () => ({ state: 'ready', indexedDocuments: docs.length }),
    async index(doc) { docs.push(doc); },
    async rebuild() {
      const vault = new MarkdownVault(root);
      docs = (await Promise.all((await vault.list()).map(({ id }) => vault.read(id)))).filter((doc): doc is SavedDocument => !!doc);
    },
    async search({ query }) {
      return { hits: docs.filter((doc) => doc.bodyMarkdown.includes(query)).map((doc) => ({ ...doc, snippet: doc.bodyMarkdown })), estimatedTotalHits: docs.length };
    },
  };
}
async function open(root: string, overrides: Partial<Parameters<typeof VaultWorkspace.open>[0]> = {}) {
  const workspace = await VaultWorkspace.open({
    defaultRoot: root, capture: { capture: async () => capture },
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: '', searchData: `${root}-search`,
    createSearch: async (destination) => ({ search: fakeSearch(destination), close: async () => undefined }),
    ...overrides,
  });
  workspaces.push(workspace);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return workspace;
}
async function waitForRestore(workspace: VaultWorkspace) {
  await expect.poll(() => workspace.status().state, { timeout: 5000 }).toMatch(/^(completed|error)$/u);
}

describe('portable vault package', () => {
  it('preserves document, binary attachment, versions and channels; excludes device files and pauses schedule', async () => {
    const root = await temp(); const a = path.join(root, 'A'); const b = path.join(root, 'B');
    await seed(a);
    await writeFile(path.join(a, 'agent-connection.json'), '{"token":"private-device-token"}');
    await writeFile(path.join(a, 'settings/credentials.json'), '{"password":"secret"}');
    const buffer = await exportVault(a);
    expect(buffer.toString()).not.toContain(a);
    expect(buffer.toString()).not.toContain('agent-connection');
    expect(buffer.toString()).not.toContain('credentials');
    await mkdir(b);
    await unpackVault(buffer, b, () => undefined);
    expect(await new MarkdownVault(b).read(`youtube:${capture.videoId}`)).toEqual(await new MarkdownVault(a).read(`youtube:${capture.videoId}`));
    expect(await readFile(path.join(b, 'attachments/sample.bin'))).toEqual(Buffer.from([0, 1, 128, 255]));
    expect(await readFile(path.join(b, 'versions/retained.md'), 'utf8')).toBe('retained version');
    expect(await new JsonChannelStore(b).list()).toEqual(await new JsonChannelStore(a).list());
    expect(await new JsonChannelScheduleStore(b).load()).toMatchObject({ enabled: false, nextRunAt: null, intervalMinutes: 60 });
    expect(await new JsonChannelScheduleStore(a).load()).toMatchObject({ enabled: true });
  });
  it.each(['../outside', '/absolute', 'attachments/../escape', 'attachments\\escape', 'attachments/C:bad', 'attachments/CON', 'attachments/trailing.', 'settings/credentials.json'])('rejects unsafe/unsupported path %s', async (file) => {
    const root = await temp();
    await expect(unpackVault(packageOf([{ path: file, data: 'unsafe' }]), root, () => undefined)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects symlinks during export', async () => {
    const root = await temp(); await mkdir(path.join(root, 'attachments'));
    const target = await temp();
    await writeFile(path.join(target, 'outside.txt'), 'outside vault');
    await symlink(target, path.join(root, 'attachments/link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(exportVault(root)).rejects.toThrow('符號連結');
  });
  it('rejects duplicate, case-collision and file/directory collision paths before writing', async () => {
    const root = await temp();
    for (const paths of [['attachments/a', 'attachments/a'], ['attachments/A', 'attachments/a'], ['attachments/a', 'attachments/a/b']]) {
      await expect(unpackVault(packageOf(paths.map((path) => ({ path, data: 'x' }))), root, () => undefined)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }
  });
  it('rejects corrupt bytes, missing files, wrong version and invalid base64', async () => {
    const root = await temp(); await seed(path.join(root, 'source'));
    const good = JSON.parse((await exportVault(path.join(root, 'source'))).toString());
    for (const mutate of [
      (data: typeof good) => { data.files[0].data = 'YQ=='; },
      (data: typeof good) => { data.files.find((entry: { path: string }) => entry.path === 'attachments/sample.bin').data = Buffer.from([0, 1, 128, 254]).toString('base64'); },
      (data: typeof good) => { data.files.pop(); },
      (data: typeof good) => { data.version = 2; },
      (data: typeof good) => { data.files[0].data += '!!'; },
    ]) {
      const data = structuredClone(good); mutate(data);
      await expect(unpackVault(Buffer.from(JSON.stringify(data)), path.join(root, 'target'), () => undefined)).rejects.toThrow();
    }
  });
});

describe('workspace transfer through HTTP', () => {
  it('restores as independent B, switches UI/Agent services, preserves old B and persists selection after restart', async () => {
    const root = await temp(); const a = path.join(root, 'A'); const b = path.join(root, 'B');
    await seed(a);
    const buffer = await exportVault(a);
    await rm(a, { recursive: true }); // A is unavailable for every restore, browse and search operation.
    await new MarkdownVault(b).add({ ...capture, videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'B 原資料' });
    const workspace = await open(b);
    const app = await createHttpApp({ collector: workspace.collector, search: workspace.search, channels: workspace.channels, schedule: workspace.schedule, transfer: workspace });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/vault/restore', headers: { 'content-type': 'application/octet-stream' }, payload: buffer });
      expect(response.statusCode).toBe(202);
      await waitForRestore(workspace);
      expect(workspace.status().state).toBe('completed');
      expect(workspace.status().vaultPath).not.toBe(b);
      expect((await app.inject('/api/documents')).json().documents.map((doc: SavedDocument) => doc.id)).toEqual([`youtube:${capture.videoId}`]);
      expect((await app.inject(`/api/documents/youtube:${capture.videoId}`)).json().document.bodyMarkdown).toBe(capture.bodyMarkdown);
      expect((await app.inject('/api/search?q=森林')).json().hits[0].id).toBe(`youtube:${capture.videoId}`);
      expect((await app.inject('/api/youtube/schedule')).json().schedule.enabled).toBe(false);
      expect(await new MarkdownVault(b).read('youtube:abcdefghijk')).not.toBeNull();
      const restoredPath = workspace.status().vaultPath;
      await workspace.close();
      const restarted = await open(b);
      expect(restarted.status().vaultPath).toBe(restoredPath);
      expect(await restarted.collector.list()).toHaveLength(1);
      expect((await restarted.schedule.getSchedule()).enabled).toBe(false);
      expect((await restarted.channels.startRun()).channelIds).toEqual(['UC123']);
    } finally { await app.close(); }
  });
  it('keeps original vault and selection when data validation or indexing fails; retry succeeds', async () => {
    const root = await temp(); const b = path.join(root, 'B'); await seed(b);
    let fail = true;
    const workspace = await open(b, { createSearch: async (destination) => {
      const search = fakeSearch(destination);
      if (destination !== b && fail) search.rebuild = async () => { throw new Error('index unavailable'); };
      return { search, close: async () => undefined };
    } });
    const before = await exportVault(b);
    for (const buffer of [Buffer.from('bad json'), packageOf([{ path: 'settings/youtube-channels.json', data: '{}' }]), packageOf([{ path: `documents/youtube/${capture.videoId}.md`, data: 'bad metadata' }]), before]) {
      workspace.restore(buffer); await waitForRestore(workspace);
      expect(workspace.status().state).toBe('error');
      expect(workspace.status().vaultPath).toBe(b);
      expect(await exportVault(b)).toEqual(before);
      expect(await readdir(`${b}.restored`)).toEqual([]);
      await expect(readFile(`${b}.active.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    fail = false;
    workspace.restore(before); await waitForRestore(workspace);
    expect(workspace.status().state).toBe('completed');
  });
  it('blocks transfer during collection and blocks HTTP writes during transfer', async () => {
    const root = await temp();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const workspace = await open(path.join(root, 'B'), { capture: { capture: async () => { await waiting; return capture; } } });
    const collection = workspace.collector.collect(capture.sourceUrl);
    await expect(workspace.export()).rejects.toMatchObject({ code: 'vault_busy' });
    expect(() => workspace.restore(packageOf([]))).toThrow('等待');
    release(); await collection;
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace });
    try {
      const pending = workspace.export();
      const response = await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: capture.sourceUrl } });
      expect(response.statusCode).toBe(409);
      await pending;
      expect((await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: capture.sourceUrl } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('Agent cannot invoke transfer routes', async () => {
    const root = await temp(); const workspace = await open(path.join(root, 'B'));
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test-token' });
    try {
      for (const url of ['/api/vault/export', '/api/vault/restore']) {
        expect((await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer test-token' } })).statusCode).toBe(403);
      }
    } finally { await app.close(); }
  });
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('rebuilds real Meilisearch on B without A and searches again after B restarts', async () => {
  const root = await temp(); const a = path.join(root, 'A'); const b = path.join(root, 'B');
  await seed(a);
  const buffer = await exportVault(a);
  await rm(a, { recursive: true });
  const options = { defaultRoot: b, capture: { capture: async () => capture },
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: path.resolve('resources/bin/mac/meilisearch'), searchData: `${b}-search` };
  const workspace = await VaultWorkspace.open(options); workspaces.push(workspace);
  await new Promise((resolve) => setTimeout(resolve, 10));
  workspace.restore(buffer);
  await waitForRestore(workspace);
  expect(workspace.status()).toMatchObject({ state: 'completed' });
  expect((await workspace.search.search({ query: '森林觀測' })).hits[0]?.id).toBe(`youtube:${capture.videoId}`);
  expect((await workspace.schedule.getSchedule()).enabled).toBe(false);
  await workspace.close();
  const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
  await expect.poll(() => restarted.search.status().state, { timeout: 5000 }).toBe('ready');
  expect((await restarted.search.search({ query: '森林觀測' })).hits[0]?.id).toBe(`youtube:${capture.videoId}`);
}, 30_000);

it('refuses transfer while a channel discovery run is still active', async () => {
  const root = await temp(); const b = path.join(root, 'B'); await seed(b);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const workspace = await open(b, { channelSource: {
    resolve: async () => ({ id: 'UC123', title: 'channel', url: 'https://www.youtube.com/channel/UC123' }),
    listVideos: async () => { await pending; return []; },
  } });
  await workspace.channels.startRun();
  await expect(workspace.export()).rejects.toMatchObject({ code: 'vault_busy' });
  release();
  await expect.poll(() => workspace.channels.isBusy()).toBe(false);
  await expect(workspace.export()).resolves.toBeInstanceOf(Buffer);
});

it('rejects invalid schedule data and empty package restores to an empty paused vault', async () => {
  const root = await temp(); const workspace = await open(path.join(root, 'B'));
  workspace.restore(packageOf([{ path: 'settings/youtube-schedule.json', data: '{"version":1,"enabled":true}' }]));
  await waitForRestore(workspace);
  expect(workspace.status().state).toBe('error');
  workspace.restore(packageOf([])); await waitForRestore(workspace);
  expect(workspace.status().state).toBe('completed');
  expect(await workspace.collector.list()).toEqual([]);
  expect((await workspace.schedule.getSchedule()).enabled).toBe(false);
});


it('rejects a checksum-valid document with an unsupported document type', async () => {
  const root = await temp(); await seed(path.join(root, 'source'));
  const markdown = await readFile(path.join(root, 'source', 'documents/youtube/dQw4w9WgXcQ.md'), 'utf8');
  const invalid = packageOf([{ path: 'documents/youtube/dQw4w9WgXcQ.md', data: markdown.replace('type: Transcript', 'type: Article') }]);
  await expect(unpackVault(invalid, path.join(root, 'destination'), () => undefined)).rejects.toThrow('格式無效');
});

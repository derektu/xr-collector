import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { ensureMarker, manifestOf, packageBytes, packageFiles, packageOf, streamBytes, unpackBytes } from './package-fixtures.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { VaultWorkspace } from '../../src/vault/workspace.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { Collector } from '../../src/core/collector.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
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
  bodyMarkdown: '獨立森林觀測資料。',
};
async function seed(root: string) {
  await new MarkdownVault(root).add(capture);
  await new JsonChannelStore(root).add({
    id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
    settings: { intervalMinutes: 60, backfillWindow: '1m', backfillMaxItems: 10 }, nextCheckAt: '2099-01-01T00:00:00.000Z', lastDispatchedAt: null,
  });
  await new JsonChannelScheduleStore(root).save({ enabled: true });
}
/** The files of a Vault's package, which say what a restore or merge would carry. */
const filesOf = async (root: string) => packageFiles(await packageBytes(root));
function fakeSearch(root: string): TranscriptSearch {
  let docs: SavedDocument[] = [];
  return {
    status: () => ({ state: 'ready', indexedDocuments: docs.length }),
    async index(doc) { docs.push(doc); },
    async remove(id) { docs = docs.filter((doc) => doc.id !== id); },
    async rebuild() {
      const vault = new MarkdownVault(root);
      docs = (await Promise.all((await vault.list()).map(({ id }) => vault.read(id)))).filter((doc): doc is SavedDocument => !!doc);
    },
    async search({ query }) {
      return { hits: docs.filter((doc) => doc.bodyMarkdown.includes(query)).map((doc) => ({ ...doc, snippet: doc.bodyMarkdown })), total: docs.length, offset: 0, limit: 50 };
    },
  };
}
/** Opens the Vault the device selection points at, as the runtime does at startup. */
async function open(root: string, overrides: Partial<Parameters<typeof VaultWorkspace.open>[0]> = {}) {
  const selection = new VaultSelection(`${root}.selection.json`);
  const selected = await selection.read();
  if (!selected) await ensureMarker(root);
  const workspace = await VaultWorkspace.open({
    root: selected ?? root, selection, profilePath: `${root}.profile`, createdBy: 'XR Collector test', capture: { capture: async () => capture },
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

describe('workspace transfer through HTTP', () => {
  it('restores as independent B, switches UI/Agent services, preserves old B and persists selection after restart', async () => {
    const root = await temp(); const a = path.join(root, 'A'); const b = path.join(root, 'B');
    await seed(a);
    const buffer = await packageBytes(a);
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
      expect(JSON.parse(await readFile(path.join(restoredPath!, VAULT_MARKER), 'utf8'))).toMatchObject({ format: 'xr-collector-vault', formatVersion: 1, createdBy: 'XR Collector test' });
      await workspace.close();
      const restarted = await open(b);
      expect(restarted.status().vaultPath).toBe(restoredPath);
      expect(await restarted.collector.list()).toHaveLength(1);
      expect((await restarted.schedule.getSchedule()).enabled).toBe(false);
      const [submission] = await restarted.channels.startRun({ trigger: 'manual' });
      expect(submission!.job.source.id).toBe('UC123');
      await restarted.jobs.whenSettled(submission!.job.id);
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
    const before = await packageBytes(b);
    const files = await filesOf(b);
    for (const buffer of [
      Buffer.from('bad json'), await packageOf([{ path: 'settings/youtube-channels.json', data: '{}' }]),
      await packageOf([{ path: `documents/youtube/${capture.videoId}.md`, data: 'bad metadata' }]), before,
    ]) {
      await workspace.restore(buffer); await waitForRestore(workspace);
      expect(workspace.status().state).toBe('error');
      expect(workspace.status().vaultPath).toBe(b);
      expect(await filesOf(b)).toEqual(files);
      expect((await readdir(root)).filter((name) => /還原|restoring/u.test(name))).toEqual([]);
      await expect(readFile(`${b}.profile/vault-restore-journal.json`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(`${b}.selection.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    fail = false;
    await workspace.restore(before); await waitForRestore(workspace);
    expect(workspace.status().state).toBe('completed');
  });
  it('waits for the running step, keeps queued jobs queued and refuses writes and a second transfer meanwhile', async () => {
    const root = await temp();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const workspace = await open(path.join(root, 'B'), { jobLimits: { capture: 1 }, capture: { capture: async (video) => {
      started.push(video.videoId);
      if (started.length === 1) await waiting;
      return { ...capture, videoId: video.videoId, sourceUrl: video.canonicalUrl };
    } } });
    const first = await workspace.jobs.submitVideo(capture.sourceUrl);
    const second = await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=abcdefghijk');
    await expect.poll(() => started.length).toBe(1);
    const app = await createHttpApp({ collector: workspace.collector, jobs: workspace.jobs, transfer: workspace });
    try {
      // The export takes the Vault at once and waits for the capture already running.
      const pending = workspace.export();
      expect(workspace.status()).toMatchObject({ state: 'waiting', operation: 'export' });
      expect((await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: capture.sourceUrl } })).statusCode).toBe(409);
      await expect(workspace.restore(await packageOf([]))).rejects.toMatchObject({ code: 'vault_busy' });
      release();
      const exported = await pending;
      // The finished capture is in the package; the queued video did not start while the Vault was held.
      expect(started).toEqual([capture.videoId]);
      expect([...(await packageFiles(await streamBytes(exported))).keys()]).toContain(`documents/youtube/${capture.videoId}.md`);
      expect(workspace.status()).toMatchObject({ state: 'completed', operation: 'export' });
      await workspace.jobs.whenSettled(first.job.id);
      expect((await workspace.jobs.whenSettled(second.job.id)).state).toBe('completed');
      expect(started).toEqual([capture.videoId, 'abcdefghijk']);
      expect((await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: capture.sourceUrl } })).statusCode).toBe(202);
    } finally { await app.close(); }
  });
  it('gives up with vault_busy when a running step outlasts the hold limit, and collection goes on', async () => {
    const root = await temp();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const workspace = await open(path.join(root, 'B'), { holdTimeoutMs: 50, capture: { capture: async () => { await waiting; return capture; } } });
    const job = await workspace.jobs.submitVideo(capture.sourceUrl);
    await expect(workspace.export()).rejects.toMatchObject({ code: 'vault_busy', message: expect.stringContaining('收集步驟') });
    expect(workspace.status()).toMatchObject({ state: 'error', operation: 'export' });
    // The lock is gone: writes and another transfer are accepted again.
    expect(() => workspace.enterWrite()()).not.toThrow();
    release();
    expect((await workspace.jobs.whenSettled(job.job.id)).state).toBe('completed');
    await expect(workspace.export()).resolves.toBeInstanceOf(Readable);
  });
  it('allows an authenticated Agent to invoke transfer routes', async () => {
    const root = await temp(); const workspace = await open(path.join(root, 'B'));
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test-token' });
    try {
      const exported = await app.inject({ method: 'POST', url: '/api/vault/export', headers: { authorization: 'Bearer test-token' } });
      expect(exported.statusCode).toBe(200);
      const restore = await app.inject({
        method: 'POST', url: '/api/vault/restore',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/octet-stream' },
        payload: exported.rawPayload,
      });
      expect(restore.statusCode).toBe(202);
      await waitForRestore(workspace);
      expect(workspace.status().state).toBe('completed');
    } finally { await app.close(); }
  });
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('rebuilds real Meilisearch on B without A and searches again after B restarts', async () => {
  const root = await temp(); const a = path.join(root, 'A'); const b = path.join(root, 'B');
  await seed(a);
  const buffer = await packageBytes(a);
  await rm(a, { recursive: true });
  await ensureMarker(b);
  const selection = new VaultSelection(`${b}.selection.json`);
  const options = { root: b, selection, profilePath: `${b}.profile`, createdBy: 'XR Collector test', capture: { capture: async () => capture },
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: path.resolve('resources/bin/mac/meilisearch'), searchData: `${b}-search` };
  const workspace = await VaultWorkspace.open(options); workspaces.push(workspace);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await workspace.restore(buffer);
  await waitForRestore(workspace);
  expect(workspace.status()).toMatchObject({ state: 'completed' });
  expect((await workspace.search.search({ query: '森林觀測' })).hits[0]?.id).toBe(`youtube:${capture.videoId}`);
  expect((await workspace.schedule.getSchedule()).enabled).toBe(false);
  await workspace.close();
  const restarted = await VaultWorkspace.open({ ...options, root: (await selection.read())! }); workspaces.push(restarted);
  await expect.poll(() => restarted.search.status().state, { timeout: 5000 }).toBe('ready');
  expect((await restarted.search.search({ query: '森林觀測' })).hits[0]?.id).toBe(`youtube:${capture.videoId}`);
}, 30_000);

it('waits for a running channel discovery before exporting', async () => {
  const root = await temp(); const b = path.join(root, 'B'); await seed(b);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const workspace = await open(b, { channelSource: {
    resolve: async () => ({ id: 'UC123', title: 'channel', url: 'https://www.youtube.com/channel/UC123' }),
    listVideos: async () => { await pending; return []; },
  } });
  await workspace.channels.startRun({ trigger: 'manual' });
  const exported = workspace.export();
  expect(workspace.status().state).toBe('waiting');
  release();
  await expect(exported).resolves.toBeInstanceOf(Readable);
});

it('rejects invalid schedule data and empty package restores to an empty paused vault', async () => {
  const root = await temp(); const workspace = await open(path.join(root, 'B'));
  await workspace.restore(await packageOf([{ path: 'settings/youtube-schedule.json', data: '{"version":1,"enabled":true}' }]));
  await waitForRestore(workspace);
  expect(workspace.status().state).toBe('error');
  await workspace.restore(await packageOf([])); await waitForRestore(workspace);
  expect(workspace.status().state).toBe('completed');
  expect(await workspace.collector.list()).toEqual([]);
  expect((await workspace.schedule.getSchedule()).enabled).toBe(false);
});


it('rejects a checksum-valid document with an unsupported document type', async () => {
  const root = await temp(); await seed(path.join(root, 'source'));
  const markdown = await readFile(path.join(root, 'source', 'documents/youtube/dQw4w9WgXcQ.md'), 'utf8');
  const invalid = await packageOf([{ path: 'documents/youtube/dQw4w9WgXcQ.md', data: markdown.replace('type: Transcript', 'type: Article') }]);
  await expect(unpackBytes(invalid, path.join(root, 'destination'))).rejects.toThrow('格式無效');
});

describe('portable subscription settings (S-T10, A4)', () => {
  it('carries each subscription with its settings and progress through a package, paused', async () => {
    const root = await temp(); const source = path.join(root, 'source'); await seed(source);
    const settings = { intervalMinutes: 180, backfillWindow: '3m' as const, backfillMaxItems: 20 };
    const outOfRange = [{ videoId: 'old00000001', before: '2026-09-01T00:00:00.000Z' }];
    await new JsonChannelStore(source).update('UC123', { lastCheckedAt: '2026-10-14T00:00:00.000Z', settings, outOfRange });
    const exported = await packageBytes(source);
    expect(JSON.parse((await packageFiles(exported)).get('settings/youtube-channels.json')!.toString()))
      .toMatchObject({ version: 2, channels: [{ id: 'UC123', settings, outOfRange }] });
    const workspace = await open(path.join(root, 'B'));

    await workspace.restore(exported); await waitForRestore(workspace);
    expect(workspace.status().state).toBe('completed');
    expect(await workspace.channels.listChannels())
      .toEqual([expect.objectContaining({ id: 'UC123', lastCheckedAt: '2026-10-14T00:00:00.000Z', settings, outOfRange })]);
    expect(await workspace.schedule.getSchedule()).toMatchObject({ enabled: false, nextCheck: null });
  });

  it('opens and exports a Vault whose subscriptions carry fields no longer in use, keeping them', async () => {
    const root = await temp(); const source = path.join(root, 'source'); await seed(source);
    const file = path.join(source, 'settings/youtube-channels.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as { channels: Record<string, unknown>[] };
    stored.channels[0] = { ...stored.channels[0], cursor: { videoId: 'cursor00001', publishedAt: null, recentIds: ['cursor00001'] }, backlog: false };
    await writeFile(file, JSON.stringify(stored));
    const workspace = await open(source);
    expect(await workspace.channels.listChannels()).toEqual([expect.objectContaining({ id: 'UC123', backlog: false })]);
    const exported = await streamBytes(await workspace.export());
    expect(JSON.parse((await packageFiles(exported)).get('settings/youtube-channels.json')!.toString()).channels[0])
      .toMatchObject({ id: 'UC123', cursor: { videoId: 'cursor00001' }, backlog: false });
  });

  it('refuses a package whose settings files are not the current version', async () => {
    const root = await temp(); const workspace = await open(path.join(root, 'B'));
    const shared = JSON.stringify([{ id: 'UC123', title: '頻道一', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-01-01T00:00:00.000Z' }]);
    for (const files of [
      [{ path: 'settings/youtube-channels.json', data: shared }],
      [{ path: 'settings/youtube-schedule.json', data: JSON.stringify({ version: 1, enabled: true, intervalMinutes: 60 }) }],
    ]) {
      await workspace.restore(await packageOf(files)); await waitForRestore(workspace);
      expect(workspace.status()).toMatchObject({ state: 'error', vaultPath: path.join(root, 'B'), message: expect.stringContaining('訂閱或排程設定格式無效') });
    }
  });
});

describe('deletion records in packages (A6)', () => {
  const deletedId = 'gone0000001';
  const record = {
    sourceType: 'youtube', sourceId: deletedId, sourceUrl: `https://www.youtube.com/watch?v=${deletedId}`, title: '已刪除的影片',
    publisherId: 'UC123', publisherName: '測試頻道', deletedAt: '2026-10-15T00:00:00.000Z',
  };

  it('exports deletions and a restore keeps them in force', async () => {
    const root = await temp(); const source = path.join(root, 'source'); await seed(source);
    await new MarkdownVault(source).add({ ...capture, videoId: deletedId, sourceUrl: record.sourceUrl, title: record.title });
    await new Collector(new MarkdownVault(source)).delete(`youtube:${deletedId}`);
    const exported = await packageBytes(source);
    const paths = (await manifestOf(exported)).files.map((file) => file.path);
    expect(paths).toContain(DELETIONS_FILE);
    expect(paths).not.toContain(`documents/youtube/${deletedId}.md`);

    const workspace = await open(path.join(root, 'B'));
    await workspace.restore(exported); await waitForRestore(workspace);
    expect(workspace.status().state).toBe('completed');
    await expect(workspace.collector.read(`youtube:${deletedId}`)).rejects.toMatchObject({ code: 'document_deleted' });
    expect(await workspace.collector.isKnown(deletedId)).toBe(true);
    expect((await workspace.collector.list()).map((document) => document.sourceId)).toEqual([capture.videoId]);
  });

  it.each([
    ['a malformed deletions file', [{ path: DELETIONS_FILE, data: JSON.stringify({ version: 1, deleted: [{ ...record, sourceId: 'short' }] }) }]],
    ['an unknown deletions version', [{ path: DELETIONS_FILE, data: JSON.stringify({ version: 9, deleted: [] }) }]],
  ])('rejects %s', async (_name, files) => {
    const root = await temp();
    await expect(unpackBytes(await packageOf(files), path.join(root, 'target'))).rejects.toThrow('刪除紀錄');
  });

  it('rejects a package holding both a document and its deletion record', async () => {
    const root = await temp(); await seed(path.join(root, 'source'));
    const markdown = await readFile(path.join(root, 'source', 'documents/youtube/dQw4w9WgXcQ.md'), 'utf8');
    const both = await packageOf([
      { path: 'documents/youtube/dQw4w9WgXcQ.md', data: markdown },
      { path: DELETIONS_FILE, data: JSON.stringify({ version: 1, deleted: [{ ...record, sourceId: 'dQw4w9WgXcQ', sourceUrl: capture.sourceUrl }] }) },
    ]);
    await expect(unpackBytes(both, path.join(root, 'target'))).rejects.toThrow('同時有內容與刪除紀錄');
  });
});

it('refuses a document deletion while a restore holds the Vault (A7)', async () => {
  const root = await temp(); const a = path.join(root, 'A'); await seed(a);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const workspace = await open(a, {
    createSearch: async (destination) => {
      const search = fakeSearch(destination);
      // The restored Vault's index build waits, so the restore keeps the Vault locked.
      if (destination !== a) search.rebuild = async () => { await held; };
      return { search, close: async () => undefined };
    },
  });
  const app = await createHttpApp({ collector: workspace.collector, transfer: workspace });
  await workspace.restore(await packageBytes(a));
  const url = `/api/documents/${encodeURIComponent(`youtube:${capture.videoId}`)}`;
  await expect.poll(async () => (await app.inject({ method: 'DELETE', url })).statusCode).toBe(409);
  release(); await waitForRestore(workspace);
  await app.close();
});

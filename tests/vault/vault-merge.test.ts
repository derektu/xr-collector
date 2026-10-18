import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { VaultWorkspace } from '../../src/vault/workspace.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { compareFiles, memorySource, mergeFiles, type FileChanges } from '../../src/vault/vault-merge.js';
import { ensureMarker, packageBytes, packageFiles, packageOf, unpackBytes } from './package-fixtures.js';
import { lineDiff } from '../../src/web/line-diff.js';
import { Collector } from '../../src/core/collector.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { startAgentAccess } from '../../src/server/agent-access.js';
import { createHttpApp } from '../../src/server/app.js';
import type { CapturedTranscript, SavedDocument, TranscriptSearch, MergePreview, MergeChoice } from '../../src/core/types.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = []; const workspaces: VaultWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const capture: CapturedTranscript = { videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  title: '本機標題', channelId: 'UC1', channelTitle: '頻道', publishedAt: null, languageCode: 'zh-Hant',
  languageName: '中文', subtitleKind: 'manual', bodyMarkdown: '舊的森林內容' };
async function add(root: string, id = capture.videoId, body = capture.bodyMarkdown) {
  return new MarkdownVault(root).add({ ...capture, videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}`, bodyMarkdown: body });
}
/** Changes a document's body the way an editor would, without collecting it again. */
async function edit(root: string, id = capture.videoId) {
  const target = path.join(root, `documents/youtube/${id}.md`);
  await writeFile(target, `${await readFile(target, 'utf8')}\n比對後加入的段落\n`);
}
async function file(root: string, name: string, data: string | Buffer) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), data);
}
async function fixture(real = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-merge-')); roots.push(root);
  const local = path.join(root, 'local'); const incoming = path.join(root, 'incoming');
  await add(local); await add(incoming, capture.videoId, '匯入的海洋內容');
  const docs = new Map<string, SavedDocument>();
  const search: TranscriptSearch = {
    status: () => ({ state: 'ready', indexedDocuments: docs.size }),
    index: vi.fn(async (doc: SavedDocument) => { docs.set(doc.id, doc); }),
    remove: vi.fn(async (id: string) => { docs.delete(id); }),
    rebuild: vi.fn(async () => {
      docs.clear(); const vault = new MarkdownVault(local);
      for (const row of await vault.list()) docs.set(row.id, (await vault.read(row.id))!);
    }),
    search: async ({ query }) => ({ hits: [...docs.values()].filter((doc) => doc.bodyMarkdown.includes(query)).map((doc) => ({ ...doc, snippet: doc.bodyMarkdown })), total: docs.size, offset: 0, limit: 50 }),
  };
  await search.rebuild(); vi.mocked(search.rebuild).mockClear();
  await ensureMarker(local);
  const options = { root: local, selection: new VaultSelection(path.join(root, 'selection.json')), profilePath: path.join(root, 'profile'), createdBy: 'XR Collector test', capture: { capture: async () => capture },
    channelSource: { resolve: async () => ({ id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1' }), listVideos: async () => [] },
    searchBinary: path.resolve('resources/bin/mac/meilisearch'), searchData: path.join(root, 'search'),
    ...(!real ? { createSearch: async () => ({ search, close: async () => undefined }) } : {}) };
  const workspace = await VaultWorkspace.open(options); workspaces.push(workspace);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { root, local, incoming, workspace, search, options };
}
/** What a package of the Vault would hold, to tell whether a merge changed it. */
const snapshot = async (root: string) => packageFiles(await packageBytes(root));
/** Merge items of two sides held in memory. */
const itemsOf = async (local: Map<string, Buffer>, incoming: Map<string, Buffer>) => (await compareFiles(memorySource(local), memorySource(incoming))).items;
/** The bytes a merge writes to a settings file. */
const written = (changes: FileChanges, file: string) => (changes.get(file) as { bytes: Buffer }).bytes.toString();
async function wait(workspace: VaultWorkspace) {
  await expect.poll(() => workspace.status().state, { timeout: 10_000 }).toMatch(/^(completed|error)$/);
}
function choices(preview: MergePreview, choice: MergeChoice = 'incoming') {
  return Object.fromEntries(preview.items.filter((item) => item.state === 'conflict').map((item) => [item.key, choice]));
}

describe('merge comparison and choices', () => {
  it('merges same, new and changed IDs, keeps local-only docs, updates only changed search documents, and is idempotent', async () => {
    const { local, incoming, workspace, search } = await fixture();
    await add(local, 'localonly01', '僅本機的山岳');
    await add(local, 'same0000001', '相同內容'); await add(incoming, 'same0000001', '相同內容');
    await add(incoming, 'new00000001', '新增沙漠');
    const buffer = await packageBytes(incoming); const preview = await workspace.previewMerge(buffer);
    expect(preview.items.map((item) => [item.key, item.state])).toEqual([
      ['documents/youtube/abcdefghijk.md', 'conflict'], ['documents/youtube/new00000001.md', 'new'], ['documents/youtube/same0000001.md', 'same'],
    ]);
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status().state).toBe('completed');
    expect(await workspace.collector.list()).toHaveLength(4);
    expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(1);
    expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(0);
    expect((await workspace.search.search({ query: '沙漠' })).hits).toHaveLength(1);
    expect(search.index).toHaveBeenCalledTimes(2); expect(search.rebuild).not.toHaveBeenCalled();
    const before = await snapshot(local);
    const again = await workspace.previewMerge(buffer);
    expect(again.items.every((item) => item.state === 'same')).toBe(true);
    workspace.applyMerge(again.id, {}); await wait(workspace);
    expect(await snapshot(local)).toEqual(before); expect(search.index).toHaveBeenCalledTimes(2);
    const backupName = (await readdir(path.dirname(local))).find((name) => name.includes('before-merge'))!;
    expect((await packageFiles(await readFile(path.join(path.dirname(local), backupName)))).get('documents/youtube/abcdefghijk.md')!.toString()).toContain('森林');
  });
  it.each(['local', 'incoming'] as const)('honors %s choice even when imported content has an older date', async (choice) => {
    const { local, incoming, workspace } = await fixture();
    const name = 'documents/youtube/abcdefghijk.md';
    const old = (await readFile(path.join(incoming, name), 'utf8')).replace(/collected_at: .*/u, 'collected_at: 2000-01-01T00:00:00.000Z');
    await file(incoming, name, old);
    const before = await readFile(path.join(local, name));
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    expect(preview.items[0]!.incomingTime).toBe('2000-01-01T00:00:00.000Z');
    workspace.applyMerge(preview.id, choices(preview, choice)); await wait(workspace);
    expect(await readFile(path.join(local, name))).toEqual(choice === 'local' ? before : Buffer.from(old));
  });
  it('compares all metadata, preserves tag-only changes, and ignores only timestamp/serialization differences', async () => {
    const { local, incoming, workspace } = await fixture(); const name = 'documents/youtube/abcdefghijk.md';
    const original = await readFile(path.join(local, name), 'utf8');
    for (const [text, expected] of [
      [original.replace(/collected_at: .*/u, 'collected_at: 2000-01-01T00:00:00.000Z'), 'same'],
      [original.replace('tags: []', 'tags: [研究]'), 'conflict'],
      [original.replace('本機標題', '另一標題'), 'conflict'],
      [original.replace('language_code: zh-Hant', 'language_code: en'), 'conflict'],
      [original.replace('森林', '森林\n\n新增段落'), 'conflict'],
    ]) {
      await file(incoming, name, text!);
      const preview = await workspace.previewMerge(await packageBytes(incoming)); expect(preview.items[0]!.state).toBe(expected);
    }
  });
  it('merges channels independently, preserves local-only channels and ignores order and addedAt-only changes', async () => {
    const { local, incoming, workspace } = await fixture();
    const settings = { intervalMinutes: 30, backfillWindow: '1m' as const, backfillMaxItems: 10 };
    const channel = { id: 'UC1', title: '本機頻道', enabled: true, url: 'https://www.youtube.com/channel/UC1', addedAt: '2026-01-01', settings };
    await new JsonChannelStore(local).add(channel);
    await new JsonChannelStore(local).add({ ...channel, id: 'UC-local' });
    await new JsonChannelStore(incoming).add({ ...channel, enabled: false });
    await new JsonChannelStore(incoming).add({ ...channel, id: 'UC-new' });
    const buffer = await packageBytes(incoming); const preview = await workspace.previewMerge(buffer);
    expect(preview.items.find((item) => item.key === 'channel:UC1')?.state).toBe('conflict');
    workspace.applyMerge(preview.id, { ...choices(preview, 'local'), 'channel:UC1': 'incoming' }); await wait(workspace);
    expect((await workspace.channels.listChannels()).map((c) => [c.id, c.enabled])).toEqual([['UC1', false], ['UC-local', true], ['UC-new', true]]);
    const again = await workspace.previewMerge(buffer);
    expect(again.items.filter((item) => item.kind === 'channel').every((item) => item.state === 'same')).toBe(true);
    // Check times describe collection, not the subscription choice.
    const progress = {
      lastCheckedAt: '2026-10-01',
      nextCheckAt: '2026-10-01T00:30:00.000Z', lastDispatchedAt: '2026-10-01T00:00:00.000Z',
    };
    const v2 = (rows: unknown[]) => Buffer.from(JSON.stringify({ version: 2, channels: rows }));
    const withProgress = new Map([['settings/youtube-channels.json', v2([{ ...channel, ...progress }])]]);
    const withoutProgress = new Map([['settings/youtube-channels.json', v2([channel])]]);
    expect((await itemsOf(withoutProgress, withProgress)).map((item) => item.state)).toEqual(['same']);
    // An imported subscription is planned again after the merge rather than keeping the other Vault's times.
    const adopted = await mergeFiles(memorySource(new Map()), memorySource(withProgress), await itemsOf(new Map(), withProgress), {});
    expect(JSON.parse(written(adopted, 'settings/youtube-channels.json'))).toEqual({
      version: 2, channels: [{ ...channel, ...progress, nextCheckAt: null, lastDispatchedAt: null }],
    });
    const a = new Map([['settings/youtube-channels.json', v2([channel, { ...channel, id: 'UC2' }])]]);
    const b = new Map([['settings/youtube-channels.json', v2([{ ...channel, id: 'UC2' }, { ...channel, addedAt: '2000' }])]]);
    expect((await itemsOf(a, b)).every((item) => item.state === 'same')).toBe(true);
  });
  it('lists different settings as a conflict of that subscription', async () => {
    const { local, incoming, workspace } = await fixture();
    const base = { title: '頻道', enabled: true, addedAt: '2026-01-01' };
    const settings = { intervalMinutes: 60, backfillWindow: '2w' as const, backfillMaxItems: 20 };
    await new JsonChannelStore(local).add({ ...base, id: 'UCsame', url: 'https://www.youtube.com/channel/UCsame', settings });
    await new JsonChannelStore(local).add({ ...base, id: 'UCdiff', url: 'https://www.youtube.com/channel/UCdiff', settings });
    await new JsonChannelStore(incoming).add({ ...base, id: 'UCsame', url: 'https://www.youtube.com/channel/UCsame', settings });
    await new JsonChannelStore(incoming).add({ ...base, id: 'UCdiff', url: 'https://www.youtube.com/channel/UCdiff', settings });
    await file(incoming, 'settings/youtube-schedule.json', JSON.stringify({ version: 2, enabled: false }));
    await workspace.channels.updateSettings('UCdiff', { intervalMinutes: 15 });
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    expect(preview.items.filter((item) => item.kind === 'channel').map((item) => [item.key, item.state])).toEqual([
      ['channel:UCsame', 'same'], ['channel:UCdiff', 'conflict'],
    ]);
    expect(preview.items.find((item) => item.key === 'channel:UCdiff')).toMatchObject({
      localText: expect.stringContaining('"intervalMinutes": 15'), incomingText: expect.stringContaining('"intervalMinutes": 60'),
    });
    // The automatic collection switch is never a merge item; this Vault keeps its own.
    expect(preview.items.some((item) => item.key === 'settings/youtube-schedule.json')).toBe(false);
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect((await workspace.channels.listChannels()).find((channel) => channel.id === 'UCdiff')!.settings).toEqual(settings);
    expect(await workspace.schedule.getSchedule()).toMatchObject({ enabled: true });
  });
  it('does not list subscriptions that differ only in fields the program does not use', async () => {
    const row = { id: 'UCold', title: '頻道', url: 'https://www.youtube.com/channel/UCold', enabled: true, addedAt: '2026-01-01',
      settings: { intervalMinutes: 60, backfillWindow: '1m', backfillMaxItems: 10 } };
    const channels = (extra: object) => new Map([['settings/youtube-channels.json',
      Buffer.from(JSON.stringify({ version: 2, channels: [{ ...row, ...extra }] }))]]);
    const items = await itemsOf(channels({ cursor: 'local-cursor', backlog: ['a'] }), channels({ cursor: 'incoming-cursor' }));
    expect(items.map((item) => [item.key, item.state])).toEqual([['channel:UCold', 'same']]);
  });
  it('refuses to merge documents whose source IDs differ in letter case alone', async () => {
    const { local, incoming, workspace } = await fixture();
    await add(local, 'Caseid00001', '大寫'); await add(incoming, 'caseid00001', '小寫');
    const before = await snapshot(local);
    await expect(workspace.previewMerge(await packageBytes(incoming))).rejects.toThrow('大小寫');
    expect(await snapshot(local)).toEqual(before);
  });
});

describe('transaction and HTTP', () => {
  it('cancels a preview without changing data and rejects its token afterward', async () => {
    const { local, incoming, workspace } = await fixture(); const before = await snapshot(local);
    const preview = await workspace.previewMerge(await packageBytes(incoming)); workspace.cancelMerge(preview.id);
    expect(await snapshot(local)).toEqual(before);
    expect(() => workspace.applyMerge(preview.id, choices(preview))).toThrow('失效');
  });
  it('rejects changed local state, missing/unknown decisions and duplicate channel IDs', async () => {
    const { local, incoming, workspace } = await fixture();
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    for (const decision of [{}, { fake: 'local' }]) {
      workspace.applyMerge(preview.id, decision as Record<string, MergeChoice>); await wait(workspace);
      expect(workspace.status().state).toBe('error');
    }
    await edit(local);
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status().message).toContain('重新比對');
    const row = { id: 'UC1', title: '', url: '', enabled: false, addedAt: '', settings: { intervalMinutes: 30, backfillWindow: '1m', backfillMaxItems: 10 } };
    await file(incoming, 'settings/youtube-channels.json', JSON.stringify({ version: 2, channels: [row, row] }));
    await expect(workspace.previewMerge(await packageBytes(incoming))).rejects.toThrow('重複');
  });
  it('restores every file and search result after a partial indexing failure and can retry', async () => {
    const { local, incoming, workspace, search } = await fixture();
    await add(incoming, 'new00000001', '新增沙漠');
    const before = await snapshot(local);
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    const realIndex = vi.mocked(search.index).getMockImplementation()!;
    vi.mocked(search.index).mockImplementationOnce(realIndex).mockRejectedValueOnce(new Error('disk/index failure'));
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status().state).toBe('error'); expect(await snapshot(local)).toEqual(before);
    expect(search.rebuild).toHaveBeenCalledTimes(1);
    expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(1);
    expect((await workspace.search.search({ query: '沙漠' })).hits).toHaveLength(0);
    expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(0);
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace); expect(workspace.status().state).toBe('completed');
  });
  it('rolls back a file-write failure after an earlier file has been replaced', async () => {
    const { local, incoming, workspace } = await fixture();
    await add(incoming, 'new00000001', '新增沙漠');
    const before = await snapshot(local);
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    const originalRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    let failed = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (!failed && String(to) === path.join(local, 'documents/youtube/new00000001.md')) {
        failed = true; throw new Error('simulated disk write failure');
      }
      return originalRename(from, to);
    });
    try {
      workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
      expect(failed).toBe(true); expect(workspace.status().state).toBe('error');
      expect(await snapshot(local)).toEqual(before);
      expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(1);
      expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(0);
    } finally { vi.mocked(rename).mockImplementation(originalRename); }
  });
  it('recovers an interrupted journal before startup exposes the vault', async () => {
    const { local, workspace, options } = await fixture();
    const bytes = await packageBytes(local); const before = await packageFiles(bytes);
    await workspace.close();
    const backup = `${local}.before-merge-interrupted.xr-vault`; await writeFile(backup, bytes);
    const changed = 'documents/youtube/abcdefghijk.md'; const added = 'documents/youtube/new00000001.md';
    await writeFile(`${local}.merge-journal.json`, JSON.stringify({ backup, paths: [changed, added] }));
    await file(local, changed, 'partially written invalid document'); await add(local, 'new00000001');
    await file(local, `${added}.12345678-1234-1234-1234-123456789012.tmp`, 'interrupted temporary write');
    const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
    expect(await snapshot(local)).toEqual(before);
    expect((await restarted.search.search({ query: '森林' })).hits).toHaveLength(1);
  });
  it('keeps the journal and blocks writes if rollback search also fails; restart repairs data and search', async () => {
    const { local, incoming, workspace, search, options } = await fixture(); const before = await snapshot(local);
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    vi.mocked(search.index).mockRejectedValueOnce(new Error('fail')); vi.mocked(search.rebuild).mockRejectedValueOnce(new Error('fail rollback'));
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status().message).toContain('重新啟動'); expect(() => workspace.enterWrite()).toThrow();
    await workspace.close();
    const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
    expect(await snapshot(local)).toEqual(before);
    await expect(readFile(`${local}.merge-journal.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await restarted.search.search({ query: '森林' })).hits).toHaveLength(1);
  });
  it('exposes preview/apply/cancel over HTTP, blocks concurrent reads/writes during apply and authorizes Agent mutations', async () => {
    const { root, incoming, workspace, search } = await fixture();
    const access = await startAgentAccess({
      collector: workspace.collector, search: workspace.search, transfer: workspace,
      instanceId: 'vault-merge-test-runtime',
      connectionFile: path.join(root, 'connection.json'), skillPath: root,
    });
    const connection = JSON.parse(await readFile(access.info.connectionFile, 'utf8'));
    const app = await createHttpApp({ collector: workspace.collector, jobs: workspace.jobs, search: workspace.search, transfer: workspace });
    const agent = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test' });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/vault/merge/preview', headers: { 'content-type': 'application/octet-stream' }, payload: await packageBytes(incoming) });
      expect(response.statusCode).toBe(200); const preview = response.json() as MergePreview;
      let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(search.index).mockImplementationOnce(async () => held);
      expect((await app.inject({ method: 'POST', url: '/api/vault/merge/apply', payload: { id: preview.id, choices: choices(preview) } })).statusCode).toBe(202);
      await expect.poll(() => workspace.status().state).toBe('indexing');
      expect((await app.inject('/api/documents')).statusCode).toBe(409);
      expect((await fetch(`${connection.url}/api/documents`, { headers: { authorization: `Bearer ${connection.token}` } })).status).toBe(409);
      expect((await app.inject('/api/vault/status')).statusCode).toBe(200);
      expect((await app.inject('/api/jobs')).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: capture.sourceUrl } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/vault/merge/cancel', payload: { id: preview.id } })).statusCode).toBe(409);
      release(); await wait(workspace);
      const agentPreview = await agent.inject({
        method: 'POST', url: '/api/vault/merge/preview',
        headers: { authorization: 'Bearer test', 'content-type': 'application/octet-stream' },
        payload: await packageBytes(incoming),
      });
      expect(agentPreview.statusCode).toBe(200);
      const cancelled = await agent.inject({
        method: 'POST', url: '/api/vault/merge/cancel', headers: { authorization: 'Bearer test' },
        payload: { id: agentPreview.json().id },
      });
      expect(cancelled.statusCode).toBe(200);
      expect((await app.inject('/api/documents')).statusCode).toBe(200);
    } finally { await app.close(); await agent.close(); await access.close(); }
  });
  it('empty package is a no-op; a malformed preview leaves the vault unchanged', async () => {
    const { root, local, workspace } = await fixture(); const before = await snapshot(local);
    const preview = await workspace.previewMerge(await packageBytes(path.join(root, 'empty')));
    expect(preview.items).toEqual([]); workspace.applyMerge(preview.id, {}); await wait(workspace);
    expect(await snapshot(local)).toEqual(before);
    await expect(workspace.previewMerge(Buffer.from('bad'))).rejects.toThrow();
    expect(await snapshot(local)).toEqual(before);
  });
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('updates real Meilisearch incrementally, removes old terms, and keeps results after restart', async () => {
  const { incoming, workspace, options } = await fixture(true);
  await expect.poll(() => workspace.search.status().state, { timeout: 10_000 }).toBe('ready');
  expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(1);
  await add(incoming, 'new00000001', '沙漠探險');
  const preview = await workspace.previewMerge(await packageBytes(incoming));
  workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
  expect(workspace.status().state).toBe('completed');
  expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(0);
  expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(1);
  expect((await workspace.search.search({ query: '沙漠' })).hits).toHaveLength(1);
  await workspace.close(); const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
  await expect.poll(() => restarted.search.status().state, { timeout: 10_000 }).toBe('ready');
  expect((await restarted.search.search({ query: '海洋' })).hits).toHaveLength(1);
}, 30_000);

describe('deletion records in a merge (A6)', () => {
  const id = `youtube:${capture.videoId}`;
  const deleteIn = (root: string) => new Collector(new MarkdownVault(root)).delete(id);
  const records = async (root: string) => (await new MarkdownVault(root).deletions.list()).map((record) => record.sourceId);

  it.each(['local', 'incoming'] as const)('asks once when the package deleted a document the Vault keeps (%s)', async (choice) => {
    const { local, incoming, workspace, search } = await fixture();
    await deleteIn(incoming);
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    expect(preview.items.map((item) => [item.key, item.kind, item.state])).toEqual([[`deletion:${id}`, 'deletion', 'conflict']]);
    expect(preview.items[0]!.label).toBe('刪除紀錄：本機標題');

    workspace.applyMerge(preview.id, choices(preview, choice)); await wait(workspace);
    expect(workspace.status().state).toBe('completed');
    if (choice === 'local') {
      expect(await workspace.collector.list()).toHaveLength(1);
      expect(await records(local)).toEqual([]);
    } else {
      expect(await workspace.collector.list()).toEqual([]);
      expect(existsSync(path.join(local, 'documents/youtube', `${capture.videoId}.md`))).toBe(false);
      expect(await records(local)).toEqual([capture.videoId]);
      expect(search.remove).toHaveBeenCalledWith(id);
      expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(0);
    }
  });

  it.each(['local', 'incoming'] as const)('asks once when the Vault deleted a document the package has (%s)', async (choice) => {
    const { local, incoming, workspace } = await fixture();
    await workspace.collector.delete(id);
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    expect(preview.items.map((item) => [item.key, item.state])).toEqual([[`deletion:${id}`, 'conflict']]);

    workspace.applyMerge(preview.id, choices(preview, choice)); await wait(workspace);
    expect(workspace.status().state).toBe('completed');
    if (choice === 'local') {
      await expect(workspace.collector.read(id)).rejects.toMatchObject({ code: 'document_deleted' });
      expect(await records(local)).toEqual([capture.videoId]);
    } else {
      expect((await workspace.collector.read(id)).bodyMarkdown).toBe('匯入的海洋內容');
      expect(await records(local)).toEqual([]);
      expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(1);
    }
  });

  it('adds a deletion that meets no document and treats deletions on both sides as the same', async () => {
    const { local, incoming, workspace } = await fixture();
    await add(incoming, 'gone0000001', '只在匯入包出現過');
    await new Collector(new MarkdownVault(incoming)).delete('youtube:gone0000001');
    await workspace.collector.delete(id);
    await deleteIn(incoming);

    const preview = await workspace.previewMerge(await packageBytes(incoming));
    expect(preview.items.map((item) => [item.key, item.state])).toEqual([
      ['deletion:youtube:gone0000001', 'new'], [`deletion:${id}`, 'same'],
    ]);
    workspace.applyMerge(preview.id, {}); await wait(workspace);
    expect((await records(local)).sort()).toEqual([capture.videoId, 'gone0000001'].sort());
    expect(await workspace.collector.isKnown('gone0000001')).toBe(true);
  });

  /** Deletes through a Vault whose file removal fails, which leaves the file next to its record. */
  async function deleteLeavingFile(root: string, at?: Date) {
    class StuckVault extends MarkdownVault {
      override async remove(): Promise<void> { throw new Error('file is locked'); }
    }
    return new Collector(new StuckVault(root, at ? { now: () => at } : {})).delete(id);
  }
  const documentPath = `documents/youtube/${capture.videoId}.md`;

  it('exports, restores and merges a Vault whose deletion left its file behind', async () => {
    const { root, local, incoming, workspace } = await fixture();
    await deleteLeavingFile(local, new Date(Date.now() + 60_000));
    expect(existsSync(path.join(local, documentPath))).toBe(true);

    const exported = await packageBytes(local);
    const files = await packageFiles(exported);
    expect(files.has(documentPath)).toBe(false);
    expect(JSON.parse(files.get(DELETIONS_FILE)!.toString()).deleted.map((r: { sourceId: string }) => r.sourceId)).toEqual([capture.videoId]);
    const restored = path.join(root, 'restored');
    await unpackBytes(exported, restored);
    expect(await new MarkdownVault(restored).list()).toEqual([]);
    expect(await records(restored)).toEqual([capture.videoId]);

    const preview = await workspace.previewMerge(await packageBytes(incoming));
    expect(preview.items.map((item) => [item.key, item.state])).toEqual([[`deletion:${id}`, 'conflict']]);
    workspace.applyMerge(preview.id, choices(preview, 'incoming')); await wait(workspace);
    expect(workspace.status().state).toBe('completed');
    expect((await workspace.collector.read(id)).bodyMarkdown).toBe('匯入的海洋內容');
    expect(await records(local)).toEqual([]);
  });

  it('leaves out a record whose document was collected again after it', async () => {
    const { local } = await fixture();
    await new MarkdownVault(local).deletions.record({
      sourceType: 'youtube', sourceId: capture.videoId, sourceUrl: capture.sourceUrl, title: capture.title, publisherId: 'UC1', publisherName: '頻道',
    });
    await new MarkdownVault(local, { now: () => new Date(Date.now() + 60_000) }).add(capture);

    const files = await snapshot(local);
    expect(files.has(documentPath)).toBe(true);
    expect(JSON.parse(files.get(DELETIONS_FILE)!.toString()).deleted).toEqual([]);
  });

  it('rolls back a failed merge into a Vault whose deletion left its file behind', async () => {
    const { local, incoming, workspace } = await fixture();
    await deleteLeavingFile(local, new Date(Date.now() + 60_000));
    await add(incoming, 'new00000001', '新增沙漠');
    const before = await snapshot(local);
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    const originalRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === path.join(local, 'documents/youtube/new00000001.md')) throw new Error('simulated disk write failure');
      return originalRename(from, to);
    });
    try {
      workspace.applyMerge(preview.id, choices(preview, 'local')); await wait(workspace);
    } finally { vi.mocked(rename).mockImplementation(originalRename); }

    expect(workspace.status().state).toBe('error');
    expect(workspace.status().message).not.toContain('重新啟動');
    expect(await snapshot(local)).toEqual(before);
    expect(() => workspace.enterWrite()()).not.toThrow();
  });

  it('recovers from a merge backup that holds a document next to its record', async () => {
    const { local, workspace, options } = await fixture();
    const files = await snapshot(local);
    await workspace.close();
    // A backup with both is still restored: recovery checks the package, not this agreement.
    files.set(DELETIONS_FILE, Buffer.from(JSON.stringify({ version: 1, deleted: [{
      sourceType: 'youtube', sourceId: capture.videoId, sourceUrl: capture.sourceUrl, title: capture.title,
      publisherId: 'UC1', publisherName: '頻道', deletedAt: new Date(Date.now() + 60_000).toISOString(),
    }] })));
    const backup = `${local}.before-merge-both.xr-vault`;
    await writeFile(backup, await packageOf([...files].map(([file, data]) => ({ path: file, data }))));
    await writeFile(`${local}.merge-journal.json`, JSON.stringify({ backup, paths: [DELETIONS_FILE] }));

    const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
    expect(existsSync(`${local}.merge-journal.json`)).toBe(false);
    expect(await records(local)).toEqual([capture.videoId]);
    expect(await restarted.collector.list()).toEqual([]);
  });

  it('restores the document and the deletions file when applying a deletion fails', async () => {
    const { local, incoming, workspace, search } = await fixture();
    await deleteIn(incoming);
    const before = await snapshot(local);
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    vi.mocked(search.remove).mockRejectedValueOnce(new Error('index failure'));
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);

    expect(workspace.status().state).toBe('error');
    expect(await snapshot(local)).toEqual(before);
    expect(existsSync(path.join(local, DELETIONS_FILE))).toBe(false);
    expect(await workspace.collector.list()).toHaveLength(1);
  });
});

describe('line diff', () => {
  it.each([['', ''], ['', '新增'], ['刪除', ''], ['a\nb', 'a\nx\nb'], ['a\nb\nc', 'c\nb\na'], ['重複\n重複', '重複'], ['甲\n乙\n丙', '甲\n丁\n丙'], ['a\n', 'a'], ['one', 'two']])('reconstructs both sides: %j → %j', (before, after) => {
    const diff = lineDiff(before, after);
    expect(diff.filter((l) => l.kind !== 'added').map((l) => l.text).join('\n')).toBe(before);
    expect(diff.filter((l) => l.kind !== 'removed').map((l) => l.text).join('\n')).toBe(after);
    if (before !== after) expect(diff.some((l) => l.kind !== 'same')).toBe(true);
  });
  it('preserves unchanged middle lines and highlights only inserted/removed lines', () => {
    expect(lineDiff('a\nold\nb\nlast', 'a\nnew\nb\nend')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' },
      { kind: 'same', text: 'b' }, { kind: 'removed', text: 'last' }, { kind: 'added', text: 'end' },
    ]);
  });
  it('handles long transcripts with bounded diff memory', () => {
    const before = Array.from({ length: 1500 }, (_, i) => `old${i}`).join('\n');
    const after = Array.from({ length: 1500 }, (_, i) => `new${i}`).join('\n');
    const diff = lineDiff(before, after);
    expect(diff.filter((l) => l.kind === 'removed').map((l) => l.text).join('\n')).toBe(before);
    expect(diff.filter((l) => l.kind === 'added').map((l) => l.text).join('\n')).toBe(after);
  });
});

describe('conflict granularity (T3)', () => {
  const settings = { intervalMinutes: 60, backfillWindow: '1m' as const, backfillMaxItems: 10 };
  const channel = { id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1', enabled: true, addedAt: '2026-01-01T00:00:00.000Z', settings };
  const v2 = (rows: unknown[], extra: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ version: 2, ...extra, channels: rows }));

  it('takes the imported settings of a subscription and keeps the local collection progress', async () => {
    const localProgress = {
      addedAt: '2025-12-01T00:00:00.000Z',
      lastCheckedAt: '2026-10-10T00:00:00.000Z', nextCheckAt: '2026-10-10T06:00:00.000Z', lastDispatchedAt: '2026-10-10T00:00:00.000Z',
    };
    const incomingRow = {
      ...channel, title: '備份的名稱', enabled: false, settings: { ...settings, intervalMinutes: 720 },
      lastCheckedAt: '2026-01-02T00:00:00.000Z',
    };
    const local = new Map([['settings/youtube-channels.json', v2([{ ...channel, ...localProgress }], { laterField: 'kept' })]]);
    const incoming = new Map([['settings/youtube-channels.json', v2([incomingRow])]]);
    const items = await itemsOf(local, incoming);
    expect(items.map((item) => [item.key, item.state])).toEqual([['channel:UC1', 'conflict']]);
    const merged = JSON.parse(written(await mergeFiles(memorySource(local), memorySource(incoming), items, { 'channel:UC1': 'incoming' }), 'settings/youtube-channels.json'));
    expect(merged).toEqual({ version: 2, laterField: 'kept', channels: [{
      ...channel, title: '備份的名稱', enabled: false, settings: { ...settings, intervalMinutes: 720 },
      addedAt: localProgress.addedAt, lastCheckedAt: localProgress.lastCheckedAt,
      nextCheckAt: null, lastDispatchedAt: null,
    }] });
    // Progress alone never makes a difference.
    expect((await itemsOf(local, new Map([['settings/youtube-channels.json', v2([{ ...channel, lastCheckedAt: incomingRow.lastCheckedAt }])]])))
      .map((item) => item.state)).toEqual(['same']);
  });

  it('applies after collection progress moves, and asks to compare again after a document changes', async () => {
    const { local, incoming, workspace } = await fixture();
    const write = (root: string, row: Record<string, unknown>) => file(root, 'settings/youtube-channels.json', JSON.stringify({ version: 2, channels: [row] }));
    await write(local, channel);
    await write(incoming, { ...channel, title: '備份的名稱' });
    let preview = await workspace.previewMerge(await packageBytes(incoming));
    // A scheduled check after the comparison moves the check times.
    await write(local, { ...channel, lastCheckedAt: '2026-10-16T00:00:00.000Z', nextCheckAt: '2026-10-16T06:00:00.000Z', lastDispatchedAt: '2026-10-16T00:00:00.000Z' });
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed' });
    expect(JSON.parse(await readFile(path.join(local, 'settings/youtube-channels.json'), 'utf8')).channels[0]).toMatchObject({ title: '備份的名稱', lastCheckedAt: '2026-10-16T00:00:00.000Z' });

    await add(incoming, 'new00000001', '新增沙漠');
    preview = await workspace.previewMerge(await packageBytes(incoming));
    await edit(local);
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status()).toMatchObject({ state: 'error', message: expect.stringContaining('重新比對') });
    expect(existsSync(path.join(local, 'documents/youtube/new00000001.md'))).toBe(false);
  });

  it('says which side holds a deletion and keeps other fields of the deletions file', async () => {
    const { local, incoming, workspace } = await fixture();
    const id = `youtube:${capture.videoId}`;
    await new Collector(new MarkdownVault(incoming)).delete(id);
    const deletions = path.join(local, DELETIONS_FILE);
    await file(local, DELETIONS_FILE, JSON.stringify({ version: 1, deleted: [], laterField: 'kept' }));
    const preview = await workspace.previewMerge(await packageBytes(incoming));
    expect(preview.items).toEqual([expect.objectContaining({ key: `deletion:${id}`, deletedOn: 'incoming', state: 'conflict' })]);
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(JSON.parse(await readFile(deletions, 'utf8'))).toMatchObject({ version: 1, laterField: 'kept', deleted: [{ sourceId: capture.videoId }] });

    const other = await fixture();
    await other.workspace.collector.delete(id);
    const reverse = await other.workspace.previewMerge(await packageBytes(other.incoming));
    expect(reverse.items).toEqual([expect.objectContaining({ key: `deletion:${id}`, deletedOn: 'local', state: 'conflict' })]);
  });

  it('compares a document without a collector section on all of its metadata', async () => {
    const bytes = (body: string) => Buffer.from(`---\ntitle: 無來源段落\nnote: x\n---\n${body}`);
    const items = await itemsOf(new Map([['documents/youtube/abcdefghijk.md', bytes('一')]]), new Map([['documents/youtube/abcdefghijk.md', bytes('二')]]));
    expect(items).toEqual([expect.objectContaining({ kind: 'document', state: 'conflict', label: '無來源段落 (abcdefghijk.md)', localTime: null, incomingTime: null })]);
  });
});

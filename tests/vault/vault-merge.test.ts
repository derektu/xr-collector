import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultWorkspace } from '../../src/vault/workspace.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { exportVault } from '../../src/vault/vault-package.js';
import { compareFiles, mergeFiles, packageFiles } from '../../src/vault/vault-merge.js';
import { lineDiff } from '../../src/web/line-diff.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';
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
    rebuild: vi.fn(async () => {
      docs.clear(); const vault = new MarkdownVault(local);
      for (const row of await vault.list()) docs.set(row.id, (await vault.read(row.id))!);
    }),
    search: async ({ query }) => ({ hits: [...docs.values()].filter((doc) => doc.bodyMarkdown.includes(query)).map((doc) => ({ ...doc, snippet: doc.bodyMarkdown })), estimatedTotalHits: docs.size }),
  };
  await search.rebuild(); vi.mocked(search.rebuild).mockClear();
  const options = { defaultRoot: local, capture: { capture: async () => capture },
    channelSource: { resolve: async () => ({ id: 'UC1', title: '頻道', url: 'https://www.youtube.com/channel/UC1' }), listVideos: async () => [] },
    searchBinary: path.resolve('resources/bin/mac/meilisearch'), searchData: path.join(root, 'search'),
    ...(!real ? { createSearch: async () => ({ search, close: async () => undefined }) } : {}) };
  const workspace = await VaultWorkspace.open(options); workspaces.push(workspace);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { root, local, incoming, workspace, search, options };
}
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
    const buffer = await exportVault(incoming); const preview = await workspace.previewMerge(buffer);
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
    const before = await exportVault(local);
    const again = await workspace.previewMerge(buffer);
    expect(again.items.every((item) => item.state === 'same')).toBe(true);
    workspace.applyMerge(again.id, {}); await wait(workspace);
    expect(await exportVault(local)).toEqual(before); expect(search.index).toHaveBeenCalledTimes(2);
    const backupName = (await readdir(path.dirname(local))).find((name) => name.includes('before-merge'))!;
    expect(packageFiles(await readFile(path.join(path.dirname(local), backupName))).get('documents/youtube/abcdefghijk.md')!.toString()).toContain('森林');
  });
  it.each(['local', 'incoming'] as const)('honors %s choice even when imported content has an older date', async (choice) => {
    const { local, incoming, workspace } = await fixture();
    const name = 'documents/youtube/abcdefghijk.md';
    const old = (await readFile(path.join(incoming, name), 'utf8')).replace(/collected_at: .*/u, 'collected_at: 2000-01-01T00:00:00.000Z');
    await file(incoming, name, old);
    const before = await readFile(path.join(local, name));
    const preview = await workspace.previewMerge(await exportVault(incoming));
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
      const preview = await workspace.previewMerge(await exportVault(incoming)); expect(preview.items[0]!.state).toBe(expected);
    }
  });
  it('merges channels independently, preserves local-only channels and ignores order and addedAt-only changes', async () => {
    const { local, incoming, workspace } = await fixture();
    const channel = { id: 'UC1', title: '本機頻道', enabled: true, url: 'https://www.youtube.com/channel/UC1', addedAt: '2026-01-01' };
    await new JsonChannelStore(local).add(channel);
    await new JsonChannelStore(local).add({ ...channel, id: 'UC-local' });
    await new JsonChannelStore(incoming).add({ ...channel, enabled: false });
    await new JsonChannelStore(incoming).add({ ...channel, id: 'UC-new' });
    const buffer = await exportVault(incoming); const preview = await workspace.previewMerge(buffer);
    expect(preview.items.find((item) => item.key === 'channel:UC1')?.state).toBe('conflict');
    workspace.applyMerge(preview.id, { ...choices(preview, 'local'), 'channel:UC1': 'incoming' }); await wait(workspace);
    expect((await workspace.channels.listChannels()).map((c) => [c.id, c.enabled])).toEqual([['UC1', false], ['UC-local', true], ['UC-new', true]]);
    const again = await workspace.previewMerge(buffer);
    expect(again.items.filter((item) => item.kind === 'channel').every((item) => item.state === 'same')).toBe(true);
    const a = new Map([['settings/youtube-channels.json', Buffer.from(JSON.stringify([channel, { ...channel, id: 'UC2' }]))]]);
    const b = new Map([['settings/youtube-channels.json', Buffer.from(JSON.stringify([{ ...channel, id: 'UC2' }, { ...channel, addedAt: '2000' }]))]]);
    expect(compareFiles(a, b).every((item) => item.state === 'same')).toBe(true);
  });
  it('shows scheduling settings, pauses adopted schedule and preserves local execution history', async () => {
    const { local, incoming, workspace } = await fixture();
    const store = new JsonChannelScheduleStore(local);
    const original = { ...(await store.load()), enabled: false, intervalMinutes: 30, lastCompletedAt: '2026-01-01' };
    await store.save(original);
    await new JsonChannelScheduleStore(incoming).save({ ...original, enabled: true, intervalMinutes: 120, lastCompletedAt: '2099-01-01', nextRunAt: '2000-01-01' });
    const preview = await workspace.previewMerge(await exportVault(incoming));
    expect(preview.items.find((item) => item.kind === 'schedule')).toMatchObject({ state: 'conflict' });
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(await workspace.schedule.getSchedule()).toMatchObject({ enabled: false, intervalMinutes: 120, lastCompletedAt: '2026-01-01', nextRunAt: null });
  });
  it('compares binary attachments, versions and management files without deleting absent files', async () => {
    const { local, incoming, workspace } = await fixture();
    for (const root of [local, incoming]) await file(root, 'versions/same.md', 'same');
    await file(local, 'attachments/a.bin', Buffer.from([0, 128, 1])); await file(incoming, 'attachments/a.bin', Buffer.from([0, 128, 2]));
    await file(local, 'management/only-local.json', '{}'); await file(incoming, 'management/new.json', '{"new":true}');
    const preview = await workspace.previewMerge(await exportVault(incoming));
    expect(preview.items.find((item) => item.key === 'attachments/a.bin')).toMatchObject({ state: 'conflict', incomingText: expect.stringContaining('SHA-256') });
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(await readFile(path.join(local, 'attachments/a.bin'))).toEqual(Buffer.from([0, 128, 2]));
    expect(await readFile(path.join(local, 'management/only-local.json'), 'utf8')).toBe('{}');
    expect(await readFile(path.join(local, 'management/new.json'), 'utf8')).toBe('{"new":true}');
  });
  it.each([['attachments/A', 'attachments/a'], ['attachments/a', 'attachments/a/b']])('rejects cross-vault path collisions: %s / %s', async (left, right) => {
    const { local, incoming, workspace } = await fixture(); await file(local, left, 'local'); await file(incoming, right, 'incoming');
    const before = await exportVault(local);
    await expect(workspace.previewMerge(await exportVault(incoming))).rejects.toThrow('衝突');
    expect(await exportVault(local)).toEqual(before);
  });
});

describe('transaction and HTTP', () => {
  it('cancels a preview without changing data and rejects its token afterward', async () => {
    const { local, incoming, workspace } = await fixture(); const before = await exportVault(local);
    const preview = await workspace.previewMerge(await exportVault(incoming)); workspace.cancelMerge(preview.id);
    expect(await exportVault(local)).toEqual(before);
    expect(() => workspace.applyMerge(preview.id, choices(preview))).toThrow('失效');
  });
  it('rejects changed local state, missing/unknown decisions and duplicate channel IDs', async () => {
    const { local, incoming, workspace } = await fixture();
    const preview = await workspace.previewMerge(await exportVault(incoming));
    for (const decision of [{}, { fake: 'local' }]) {
      workspace.applyMerge(preview.id, decision as Record<string, MergeChoice>); await wait(workspace);
      expect(workspace.status().state).toBe('error');
    }
    await add(local, 'newlocal001');
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status().message).toContain('重新比對');
    const row = { id: 'UC1', title: '', url: '', enabled: false, addedAt: '' };
    await file(incoming, 'settings/youtube-channels.json', JSON.stringify([row, row]));
    await expect(workspace.previewMerge(await exportVault(incoming))).rejects.toThrow('重複');
  });
  it('restores every file and search result after a partial indexing failure and can retry', async () => {
    const { local, incoming, workspace, search } = await fixture();
    await add(incoming, 'new00000001', '新增沙漠');
    const before = await exportVault(local);
    const preview = await workspace.previewMerge(await exportVault(incoming));
    const realIndex = vi.mocked(search.index).getMockImplementation()!;
    vi.mocked(search.index).mockImplementationOnce(realIndex).mockRejectedValueOnce(new Error('disk/index failure'));
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status().state).toBe('error'); expect(await exportVault(local)).toEqual(before);
    expect(search.rebuild).toHaveBeenCalledTimes(1);
    expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(1);
    expect((await workspace.search.search({ query: '沙漠' })).hits).toHaveLength(0);
    expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(0);
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace); expect(workspace.status().state).toBe('completed');
  });
  it('rolls back a file-write failure after an earlier file has been replaced', async () => {
    const { local, incoming, workspace } = await fixture();
    await add(incoming, 'new00000001', '新增沙漠');
    const before = await exportVault(local);
    const preview = await workspace.previewMerge(await exportVault(incoming));
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
      expect(await exportVault(local)).toEqual(before);
      expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(1);
      expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(0);
    } finally { vi.mocked(rename).mockImplementation(originalRename); }
  });
  it('recovers an interrupted journal before startup exposes the vault', async () => {
    const { local, workspace, options } = await fixture();
    const before = await exportVault(local);
    await workspace.close();
    const backup = `${local}.before-merge-interrupted.xr-vault`; await writeFile(backup, before);
    const changed = 'documents/youtube/abcdefghijk.md'; const added = 'documents/youtube/new00000001.md';
    await writeFile(`${local}.merge-journal.json`, JSON.stringify({ backup, paths: [changed, added] }));
    await file(local, changed, 'partially written invalid document'); await add(local, 'new00000001');
    await file(local, `${added}.12345678-1234-1234-1234-123456789012.tmp`, 'interrupted temporary write');
    const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
    expect(await exportVault(local)).toEqual(before);
    expect((await restarted.search.search({ query: '森林' })).hits).toHaveLength(1);
  });
  it('keeps the journal and blocks writes if rollback search also fails; restart repairs data and search', async () => {
    const { local, incoming, workspace, search, options } = await fixture(); const before = await exportVault(local);
    const preview = await workspace.previewMerge(await exportVault(incoming));
    vi.mocked(search.index).mockRejectedValueOnce(new Error('fail')); vi.mocked(search.rebuild).mockRejectedValueOnce(new Error('fail rollback'));
    workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
    expect(workspace.status().message).toContain('重新啟動'); expect(() => workspace.enterWrite()).toThrow();
    await workspace.close();
    const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
    expect(await exportVault(local)).toEqual(before);
    await expect(readFile(`${local}.merge-journal.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await restarted.search.search({ query: '森林' })).hits).toHaveLength(1);
  });
  it('exposes preview/apply/cancel over HTTP, blocks concurrent reads/writes during apply and denies Agent mutations', async () => {
    const { root, incoming, workspace, search } = await fixture();
    const access = await startAgentAccess({ collector: workspace.collector, search: workspace.search, transfer: workspace, connectionFile: path.join(root, 'connection.json'), skillPath: root });
    const connection = JSON.parse(await readFile(access.info.connectionFile, 'utf8'));
    const app = await createHttpApp({ collector: workspace.collector, search: workspace.search, transfer: workspace });
    const agent = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test' });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/vault/merge/preview', headers: { 'content-type': 'application/octet-stream' }, payload: await exportVault(incoming) });
      expect(response.statusCode).toBe(200); const preview = response.json() as MergePreview;
      let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(search.index).mockImplementationOnce(async () => held);
      expect((await app.inject({ method: 'POST', url: '/api/vault/merge/apply', payload: { id: preview.id, choices: choices(preview) } })).statusCode).toBe(202);
      await expect.poll(() => workspace.status().state).toBe('indexing');
      expect((await app.inject('/api/documents')).statusCode).toBe(409);
      expect((await fetch(`${connection.url}/api/documents`, { headers: { authorization: `Bearer ${connection.token}` } })).status).toBe(409);
      expect((await app.inject('/api/vault/status')).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: capture.sourceUrl } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/vault/merge/cancel', payload: { id: preview.id } })).statusCode).toBe(409);
      release(); await wait(workspace);
      for (const action of ['preview', 'apply', 'cancel']) expect((await agent.inject({ method: 'POST', url: `/api/vault/merge/${action}`, headers: { authorization: 'Bearer test' }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject('/api/documents')).statusCode).toBe(200);
    } finally { await app.close(); await agent.close(); await access.close(); }
  });
  it('empty package is a no-op; a malformed preview leaves the vault unchanged', async () => {
    const { root, local, workspace } = await fixture(); const before = await exportVault(local);
    const preview = await workspace.previewMerge(await exportVault(path.join(root, 'empty')));
    expect(preview.items).toEqual([]); workspace.applyMerge(preview.id, {}); await wait(workspace);
    expect(await exportVault(local)).toEqual(before);
    await expect(workspace.previewMerge(Buffer.from('bad'))).rejects.toThrow();
    expect(await exportVault(local)).toEqual(before);
  });
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('updates real Meilisearch incrementally, removes old terms, and keeps results after restart', async () => {
  const { incoming, workspace, options } = await fixture(true);
  await expect.poll(() => workspace.search.status().state, { timeout: 10_000 }).toBe('ready');
  expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(1);
  await add(incoming, 'new00000001', '沙漠探險');
  const preview = await workspace.previewMerge(await exportVault(incoming));
  workspace.applyMerge(preview.id, choices(preview)); await wait(workspace);
  expect(workspace.status().state).toBe('completed');
  expect((await workspace.search.search({ query: '森林' })).hits).toHaveLength(0);
  expect((await workspace.search.search({ query: '海洋' })).hits).toHaveLength(1);
  expect((await workspace.search.search({ query: '沙漠' })).hits).toHaveLength(1);
  await workspace.close(); const restarted = await VaultWorkspace.open(options); workspaces.push(restarted);
  await expect.poll(() => restarted.search.status().state, { timeout: 10_000 }).toBe('ready');
  expect((await restarted.search.search({ query: '海洋' })).hits).toHaveLength(1);
}, 30_000);

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

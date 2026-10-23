import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { manifestOf, packageBytes, packageFiles, packageOf, unpackBytes } from './package-fixtures.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { subscriptionCollections, VaultWorkspace } from '../../src/vault/workspace.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { Collector } from '../../src/core/collector.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { importNewVault } from '../../src/vault/vault-import.js';
import type { SavedDocument } from '../../src/core/types.js';
import { capture, cleanUp, fileOf, machine, open, seed, settled, temp, type Machine } from './exchange-fixtures.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { youtubeKey } from '../support/youtube-documents.js';

afterEach(cleanUp);

/** The files of a Vault's export, which say what an import would carry. */
const filesOf = async (root: string) => packageFiles(await packageBytes(root));

/** Creates a machine's Vault from an export file as Onboarding does, and names it in the machine's selection. */
async function importAsNew(at: Machine, file: string): Promise<string> {
  const target = await importNewVault({ packageFile: file, folder: at.vault, profilePath: at.profile, createdBy: 'XR Collector test' });
  await new VaultSelection(path.join(at.profile, 'vault-selection.json')).write(target);
  return target;
}

describe('workspace transfer through HTTP', () => {
  it('creates B from an export of A that is gone, serves it to UI and Agent and keeps it after restart', async () => {
    const root = await temp(); const a = await machine('A', root); const b = await machine('B', root);
    await seed(a.vault);
    const file = await fileOf(a.exports, 'a.zip', await packageBytes(a.vault));
    await rm(a.vault, { recursive: true }); // A is unavailable for the import, browse and search alike.
    const target = await importAsNew(b, file);
    const workspace = await open(b);
    const app = await createHttpApp({ collector: workspace.collector, search: workspace.search, subscriptions: subscriptionCollections(() => workspace.subscriptions), schedule: workspace.schedule, transfer: workspace });
    try {
      expect(workspace.status().vaultPath).toBe(target);
      expect((await app.inject('/api/documents')).json().documents.map((doc: SavedDocument) => doc.id)).toEqual([`youtube:${capture.videoId}`]);
      expect((await app.inject(`/api/documents/youtube:${capture.videoId}`)).json().document.bodyMarkdown).toBe(capture.bodyMarkdown);
      expect((await app.inject('/api/schedule')).json().schedule.enabled).toBe(true);
      expect(JSON.parse(await readFile(path.join(target, VAULT_MARKER), 'utf8'))).toMatchObject({ format: 'xr-collector-vault', formatVersion: 1, createdBy: 'XR Collector test' });
    } finally { await app.close(); }
    await workspace.close();
    const restarted = await open(b);
    expect(restarted.status().vaultPath).toBe(target);
    expect(await restarted.collector.list()).toHaveLength(1);
    expect((await restarted.schedule.getSchedule()).enabled).toBe(true);
    const [submission] = await restarted.subscriptions.of('youtube')!.startRun({ trigger: 'manual' });
    expect(submission!.job.source.id).toBe('UC123');
    await restarted.jobs.whenSettled(submission!.job.id);
  });

  it('refuses an export file whose content is invalid and leaves the Vault and its comparison state as they were', async () => {
    const b = await machine('B'); await seed(b.vault);
    const workspace = await open(b);
    const files = await filesOf(b.vault);
    for (const [name, bytes] of [
      ['text.zip', Buffer.from('bad json')], ['channels.zip', await packageOf([{ path: 'settings/youtube-channels.json', data: '{}' }])],
      ['metadata.zip', await packageOf([{ path: `documents/youtube/${capture.videoId}.md`, data: 'bad metadata' }])],
      ['schedule.zip', await packageOf([{ path: 'settings/youtube-schedule.json', data: '{"version":1,"enabled":true}' }])],
    ] as const) {
      await expect(workspace.previewImport(await fileOf(b.root, name, bytes)), name).rejects.toMatchObject({ code: 'invalid_request' });
      expect(workspace.status()).toMatchObject({ state: 'error', operation: 'import', vaultPath: b.vault });
      expect(await filesOf(b.vault)).toEqual(files);
      expect((await readdir(b.vault)).filter((entry) => entry.startsWith('.xr-collector-import-'))).toEqual([]);
    }
    expect(existsSync(b.exports)).toBe(false);
  });

  it('waits for the running step, keeps queued jobs queued and refuses writes and a second transfer meanwhile', async () => {
    const b = await machine('B');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const workspace = await open(b, { jobLimits: { capture: 1 }, capture: { capture: async (video) => {
      started.push(video.videoId);
      if (started.length === 1) await waiting;
      return { ...capture, videoId: video.videoId, sourceUrl: video.canonicalUrl };
    } } });
    const first = await workspace.jobs.submitItem('youtube', capture.sourceUrl);
    const second = await workspace.jobs.submitItem('youtube', 'https://www.youtube.com/watch?v=abcdefghijk');
    await expect.poll(() => started.length).toBe(1);
    const app = await createHttpApp({ collector: workspace.collector, jobs: workspace.jobs, transfer: workspace });
    try {
      // The export takes the Vault at once and waits for the capture already running.
      const pending = workspace.exportTo();
      await expect.poll(() => workspace.status()).toMatchObject({ state: 'waiting', operation: 'export' });
      expect((await app.inject({ method: 'POST', url: '/api/items', payload: { url: capture.sourceUrl } })).statusCode).toBe(409);
      await expect(workspace.previewImport(await fileOf(b.root, 'empty.zip', await packageOf([])))).rejects.toMatchObject({ code: 'vault_busy' });
      release();
      const exported = await pending;
      // The finished capture is in the export; the queued video did not start while the Vault was held.
      expect(started).toEqual([capture.videoId]);
      expect([...(await packageFiles(await readFile(exported.result!.exportPath!))).keys()]).toContain(`documents/youtube/${capture.videoId}.md`);
      expect(workspace.status()).toMatchObject({ state: 'completed', operation: 'export' });
      await workspace.jobs.whenSettled(first.job.id);
      expect((await workspace.jobs.whenSettled(second.job.id)).state).toBe('completed');
      expect(started).toEqual([capture.videoId, 'abcdefghijk']);
      expect((await app.inject({ method: 'POST', url: '/api/items', payload: { url: capture.sourceUrl } })).statusCode).toBe(202);
    } finally { await app.close(); }
  });

  it('gives up with vault_busy when a running step outlasts the hold limit, and collection goes on', async () => {
    const b = await machine('B');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const workspace = await open(b, { holdTimeoutMs: 50, capture: { capture: async () => { await waiting; return capture; } } });
    const job = await workspace.jobs.submitItem('youtube', capture.sourceUrl);
    await expect(workspace.exportTo()).rejects.toMatchObject({ code: 'vault_busy', message: expect.stringContaining('收集步驟') });
    expect(workspace.status()).toMatchObject({ state: 'error', operation: 'export' });
    // The lock is gone: writes and another transfer are accepted again.
    expect(() => workspace.enterWrite()()).not.toThrow();
    release();
    expect((await workspace.jobs.whenSettled(job.job.id)).state).toBe('completed');
    await expect(workspace.exportTo()).resolves.toMatchObject({ state: 'completed' });
  });
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('builds real Meilisearch for a Vault imported from A that is gone, and searches again after restart', async () => {
  const root = await temp(); const a = await machine('A', root); const b = await machine('B', root);
  await seed(a.vault);
  const file = await fileOf(a.exports, 'a.zip', await packageBytes(a.vault));
  await rm(a.vault, { recursive: true });
  await importAsNew(b, file);
  const real = { searchBinary: path.resolve('resources/bin/mac/meilisearch'), createSearch: undefined };
  const workspace = await open(b, real, false);
  try {
    await expect.poll(() => workspace.search.status().state, { timeout: 10_000 }).toBe('ready');
    await expect.poll(async () => (await workspace.search.search({ query: '森林觀測' })).hits[0]?.id, { timeout: 10_000 }).toBe(`youtube:${capture.videoId}`);
    expect((await workspace.schedule.getSchedule()).enabled).toBe(true);
  } finally { await workspace.close(); }
  const restarted = await open(b, real, false);
  try {
    await expect.poll(() => restarted.search.status().state, { timeout: 10_000 }).toBe('ready');
    expect((await restarted.search.search({ query: '森林觀測' })).hits[0]?.id).toBe(`youtube:${capture.videoId}`);
  } finally { await restarted.close(); }
}, 60_000);

it('waits for a running channel discovery before exporting', async () => {
  const b = await machine('B'); await seed(b.vault);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const workspace = await open(b, { channelSource: {
    resolve: async () => ({ id: 'UC123', title: 'channel', url: 'https://www.youtube.com/channel/UC123' }),
    listVideos: async () => { await pending; return []; },
  } });
  await workspace.subscriptions.of('youtube')!.startRun({ trigger: 'manual' });
  const exported = workspace.exportTo();
  await expect.poll(() => workspace.status().state).toBe('waiting');
  release();
  await expect(exported).resolves.toMatchObject({ state: 'completed' });
});

it('rejects a checksum-valid document with an unsupported document type', async () => {
  const root = await temp(); await seed(path.join(root, 'source'));
  const markdown = await readFile(path.join(root, 'source', 'documents/youtube/dQw4w9WgXcQ.md'), 'utf8');
  const invalid = await packageOf([{ path: 'documents/youtube/dQw4w9WgXcQ.md', data: markdown.replace('type: Transcript', 'type: Article') }]);
  await expect(unpackBytes(invalid, path.join(root, 'destination'))).rejects.toThrow('格式無效');
});

describe('portable subscription settings (S-T10, A4)', () => {
  it('carries each subscription with its settings and progress, and the collection switch, into a new Vault', async () => {
    const root = await temp(); const a = await machine('A', root); const b = await machine('B', root);
    await seed(a.vault);
    const settings = { intervalMinutes: 180, backfillDays: 45, backfillMaxItems: 20 };
    const outOfRange = [{ videoId: 'old00000001', before: '2026-09-01T00:00:00.000Z' }];
    await new JsonSubscriptionStore(a.vault, 'youtube').update('UC123', { lastCheckedAt: '2026-10-14T00:00:00.000Z', settings, outOfRange });
    const exported = await packageBytes(a.vault);
    expect(JSON.parse((await packageFiles(exported)).get('settings/youtube-channels.json')!.toString()))
      .toMatchObject({ version: 3, channels: [{ id: 'UC123', settings, outOfRange }] });
    await importAsNew(b, await fileOf(a.exports, 'a.zip', exported));
    const workspace = await open(b);
    expect(await workspace.subscriptions.of('youtube')!.list())
      .toEqual([expect.objectContaining({ id: 'UC123', lastCheckedAt: '2026-10-14T00:00:00.000Z', settings, outOfRange })]);
    expect(await workspace.schedule.getSchedule()).toMatchObject({ enabled: true });
  });

  it('opens and exports a Vault whose subscriptions carry fields no longer in use, keeping them', async () => {
    const a = await machine('A'); await seed(a.vault);
    const file = path.join(a.vault, 'settings/youtube-channels.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as { channels: Record<string, unknown>[] };
    stored.channels[0] = { ...stored.channels[0], cursor: { videoId: 'cursor00001', publishedAt: null, recentIds: ['cursor00001'] }, backlog: false };
    await writeFile(file, JSON.stringify(stored));
    const workspace = await open(a);
    expect(await workspace.subscriptions.of('youtube')!.list()).toEqual([expect.objectContaining({ id: 'UC123', backlog: false })]);
    const { result } = await workspace.exportTo();
    expect(JSON.parse((await packageFiles(await readFile(result!.exportPath!))).get('settings/youtube-channels.json')!.toString()).channels[0])
      .toMatchObject({ id: 'UC123', cursor: { videoId: 'cursor00001' }, backlog: false });
  });

  it('refuses an export file whose settings files are not the current version', async () => {
    const b = await machine('B'); const workspace = await open(b);
    const shared = JSON.stringify([{ id: 'UC123', title: '頻道一', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-01-01T00:00:00.000Z' }]);
    for (const files of [
      [{ path: 'settings/youtube-channels.json', data: shared }],
      [{ path: 'settings/youtube-schedule.json', data: JSON.stringify({ version: 1, enabled: true, intervalMinutes: 60 }) }],
    ]) {
      await expect(workspace.previewImport(await fileOf(b.root, 'old.zip', await packageOf(files))))
        .rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('訂閱或排程設定格式無效') });
      expect(workspace.status()).toMatchObject({ state: 'error', vaultPath: b.vault });
    }
  });
});

describe('deletion records in export files (A6)', () => {
  const deletedId = 'gone0000001';
  const record = {
    sourceType: 'youtube', sourceId: deletedId, sourceUrl: `https://www.youtube.com/watch?v=${deletedId}`, title: '已刪除的影片',
    publisherId: 'UC123', publisherName: '測試頻道', deletedAt: '2026-10-15T00:00:00.000Z',
  };

  it('exports deletions and a Vault imported from the export keeps them in force', async () => {
    const root = await temp(); const a = await machine('A', root); const b = await machine('B', root);
    await seed(a.vault);
    await new MarkdownVault(a.vault).add(transcriptDocument({ ...capture, videoId: deletedId, sourceUrl: record.sourceUrl, title: record.title }));
    await new Collector(new MarkdownVault(a.vault)).delete(`youtube:${deletedId}`);
    const exported = await packageBytes(a.vault);
    const paths = (await manifestOf(exported)).files.map((file) => file.path);
    expect(paths).toContain(DELETIONS_FILE);
    expect(paths).not.toContain(`documents/youtube/${deletedId}.md`);

    await importAsNew(b, await fileOf(a.exports, 'a.zip', exported));
    const workspace = await open(b);
    await expect(workspace.collector.read(`youtube:${deletedId}`)).rejects.toMatchObject({ code: 'document_deleted' });
    expect(await workspace.collector.isKnown(youtubeKey(deletedId))).toBe(true);
    expect((await workspace.collector.list()).map((document) => document.sourceId)).toEqual([capture.videoId]);
  });

  it.each([
    ['a malformed deletions file', [{ path: DELETIONS_FILE, data: JSON.stringify({ version: 1, deleted: [{ ...record, sourceId: 'short' }] }) }]],
    ['an unknown deletions version', [{ path: DELETIONS_FILE, data: JSON.stringify({ version: 9, deleted: [] }) }]],
  ])('rejects %s', async (_name, files) => {
    const root = await temp();
    await expect(unpackBytes(await packageOf(files), path.join(root, 'target'))).rejects.toThrow('刪除紀錄');
  });

  it('rejects an export file holding both a document and its deletion record', async () => {
    const root = await temp(); await seed(path.join(root, 'source'));
    const markdown = await readFile(path.join(root, 'source', 'documents/youtube/dQw4w9WgXcQ.md'), 'utf8');
    const both = await packageOf([
      { path: 'documents/youtube/dQw4w9WgXcQ.md', data: markdown },
      { path: DELETIONS_FILE, data: JSON.stringify({ version: 1, deleted: [{ ...record, sourceId: 'dQw4w9WgXcQ', sourceUrl: capture.sourceUrl }] }) },
    ]);
    await expect(unpackBytes(both, path.join(root, 'target'))).rejects.toThrow('同時有內容與刪除紀錄');
  });
});

it('refuses a document deletion while an import holds the Vault (A7)', async () => {
  const root = await temp(); const a = await machine('A', root); const b = await machine('B', root);
  await seed(a.vault); await seed(b.vault);
  await new MarkdownVault(a.vault).add(transcriptDocument({ ...capture, videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // The import stops once its files are staged, so it keeps the Vault locked.
  const workspace = await open(b, { importFaults: async (phase) => { if (phase === 'staged') await held; } });
  const app = await createHttpApp({ collector: workspace.collector, transfer: workspace });
  try {
    const preview = await workspace.previewImport(await fileOf(a.exports, 'a.zip', await packageBytes(a.vault)));
    workspace.applyImport(preview.id, 'merge', {});
    const url = `/api/documents/${encodeURIComponent(`youtube:${capture.videoId}`)}`;
    await expect.poll(async () => (await app.inject({ method: 'DELETE', url })).statusCode).toBe(409);
    release(); await settled(workspace);
    expect(workspace.status().state).toBe('completed');
  } finally { await app.close(); }
});

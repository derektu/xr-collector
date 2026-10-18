import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';
import { Collector } from '../../src/core/collector.js';
import type { CapturedTranscript, SavedDocument, TranscriptSearch } from '../../src/core/types.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { EXPORT_LOG, markerDigest, RESTORE_JOURNAL } from '../../src/vault/transfer-files.js';
import { writeVaultMarker } from '../../src/vault/vault-directory.js';
import { ensureMarker, manifestOf, packageBytes, packageOf, streamBytes, unpackBytes, zipEntries } from './package-fixtures.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { VaultWorkspace } from '../../src/vault/workspace.js';

const roots: string[] = [];
const workspaces: VaultWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-backup-'));
  roots.push(root);
  return root;
}
const capture: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: '備份測試', channelId: 'UC123', channelTitle: '測試頻道', publishedAt: null,
  languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual', bodyMarkdown: '森林觀測資料。',
};
const settings = { intervalMinutes: 60, backfillWindow: '1m' as const, backfillMaxItems: 10 };
async function seed(root: string) {
  await new MarkdownVault(root).add(capture);
  await new JsonChannelStore(root).add({
    id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
    settings, nextCheckAt: '2099-01-01T00:00:00.000Z', lastDispatchedAt: null,
  });
  await new JsonChannelScheduleStore(root).save({ enabled: true });
}
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
    async search() { return { hits: [], total: 0, offset: 0, limit: 50 }; },
  };
}

interface Setup { root: string; vault: string; profile: string; jobStore: JobStore }
async function setup(): Promise<Setup> {
  const root = await temp();
  return { root, vault: path.join(root, 'Vault'), profile: path.join(root, 'profile'), jobStore: JobStore.memory() };
}
async function open(at: Setup, overrides: Partial<Parameters<typeof VaultWorkspace.open>[0]> = {}) {
  const selection = new VaultSelection(path.join(at.profile, 'vault-selection.json'));
  const selected = await selection.read();
  if (!selected) await ensureMarker(at.vault);
  const workspace = await VaultWorkspace.open({
    root: selected ?? at.vault, selection, profilePath: at.profile, createdBy: 'XR Collector test',
    capture: { capture: async () => capture }, jobStore: at.jobStore,
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: '', searchData: path.join(at.root, 'search'),
    createSearch: async (destination) => ({ search: fakeSearch(destination), close: async () => undefined }),
    ...overrides,
  });
  workspaces.push(workspace);
  return workspace;
}
async function settled(workspace: VaultWorkspace) {
  await expect.poll(() => workspace.status().state, { timeout: 5000 }).toMatch(/^(completed|error)$/u);
}

describe('package description and unknown fields (T1)', () => {
  it('describes a package for people in its manifest, which a reader does not need', async () => {
    const at = await setup(); await seed(at.vault);
    const workspace = await open(at);
    const described = await streamBytes(await workspace.export());
    expect(await manifestOf(described)).toMatchObject({
      format: 'xr-collector-package', formatVersion: 1, createdBy: 'XR Collector test', exportedAt: expect.any(String),
      summary: { documents: 1, subscriptions: 1, deletions: 0 },
    });
    // The merge backup carries no description; its files are the same.
    const plain = await packageBytes(at.vault);
    expect(await manifestOf(plain)).not.toHaveProperty('exportedAt');
    expect((await manifestOf(plain)).files).toEqual((await manifestOf(described)).files);
    // A reader ignores manifest fields it does not know.
    const manifest = await manifestOf(described);
    const entries = [...(await zipEntries(described))].filter(([name]) => name !== 'manifest.json');
    const extended = await packageOf(entries.map(([file, data]) => ({ path: file, data })), { ...manifest, laterField: { any: 'value' } });
    await expect(unpackBytes(extended, path.join(at.root, 'unpacked'))).resolves.toBeUndefined();
  });

  it('keeps fields it does not know through a restore', async () => {
    const at = await setup(); await seed(at.vault);
    const markdown = await readFile(path.join(at.vault, `documents/youtube/${capture.videoId}.md`), 'utf8');
    const row = { id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
      settings, nextCheckAt: null, lastDispatchedAt: null, laterRowField: 'row' };
    const buffer = await packageOf([
      { path: `documents/youtube/${capture.videoId}.md`, data: markdown.replace('type: Transcript', 'type: Transcript\nlater_frontmatter: kept') },
      { path: 'settings/youtube-channels.json', data: JSON.stringify({ version: 2, channels: [row], laterFileField: 'channels' }) },
      { path: 'settings/youtube-schedule.json', data: JSON.stringify({ version: 2, enabled: true, laterFileField: 'schedule' }) },
      { path: 'settings/deleted-documents.json', data: JSON.stringify({ version: 1, deleted: [], laterFileField: 'deletions' }) },
    ]);
    const target = path.join(at.root, 'Restored');
    const workspace = await open(at);
    await workspace.restore(buffer, target); await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: target });
    const json = async (file: string) => JSON.parse(await readFile(path.join(target, file), 'utf8'));
    expect(await json('settings/youtube-channels.json')).toMatchObject({ laterFileField: 'channels', channels: [{ laterRowField: 'row' }] });
    // The restored Vault starts paused; pausing keeps the other fields of the switch file.
    expect(await json('settings/youtube-schedule.json')).toEqual({ version: 2, enabled: false, laterFileField: 'schedule' });
    expect(await json('settings/deleted-documents.json')).toMatchObject({ laterFileField: 'deletions' });
    expect(await readFile(path.join(target, `documents/youtube/${capture.videoId}.md`), 'utf8')).toContain('later_frontmatter: kept');
  });

  it('refuses a package with a file path it does not know', async () => {
    const at = await setup();
    await expect(unpackBytes(await packageOf([{ path: 'settings/future.json', data: '{}' }]), path.join(at.root, 'x')))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('restore into a chosen folder (T5)', () => {
  it('stops the unfinished jobs of the previous Vault, which continue when it opens again', async () => {
    const at = await setup(); await seed(at.vault);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const slowCapture = { capture: async (video: { videoId: string; canonicalUrl: string }) => {
      started.push(video.videoId);
      if (started.length === 1) await waiting;
      return { ...capture, videoId: video.videoId, sourceUrl: video.canonicalUrl };
    } };
    const workspace = await open(at, { jobLimits: { capture: 1 }, capture: slowCapture });
    const running = await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    const queued = await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=bbbbbbbbbbb');
    await expect.poll(() => started.length).toBe(1);

    const target = path.join(at.root, 'Restored');
    await workspace.restore(await packageBytes(at.vault), target);
    expect(workspace.status()).toMatchObject({ state: 'waiting', operation: 'restore' });
    release(); await settled(workspace);
    expect(workspace.status()).toMatchObject({
      state: 'completed', vaultPath: target,
      result: { previousVaultPath: at.vault, interruptedJobs: 1, autoCollectionPaused: true },
    });
    // The queued video never started; it belongs to the previous Vault and is recorded as interrupted there.
    expect(started).toEqual(['aaaaaaaaaaa']);
    expect(at.jobStore.get(running.job.id)!.state).toBe('completed');
    expect(at.jobStore.get(queued.job.id)).toMatchObject({ state: 'interrupted', vaultPath: at.vault });
    expect(workspace.jobs.isBusy()).toBe(false);
    expect((await workspace.schedule.getSchedule()).enabled).toBe(false);
    expect(JSON.parse(await readFile(path.join(at.profile, 'vault-selection.json'), 'utf8'))).toEqual({ path: target });
    expect((await at.jobStore.activity.query({}, { vaultPath: target })).events.some((event) => event.eventType === 'vault.restored'
      && event.message.includes(at.vault) && event.message.includes('自動收集已暫停'))).toBe(true);
    await workspace.close();

    // Opening the previous Vault again picks its job up.
    await writeFile(path.join(at.profile, 'vault-selection.json'), JSON.stringify({ path: at.vault }));
    const previous = await open(at, { capture: slowCapture });
    expect((await previous.jobs.whenSettled(queued.job.id)).state).toBe('completed');
    expect(await previous.collector.isKnown('bbbbbbbbbbb')).toBe(true);
  });

  it('accepts a missing or empty folder and refuses one with content, inside the Vault or the profile', async () => {
    const at = await setup(); await seed(at.vault);
    await mkdir(at.profile, { recursive: true });
    const workspace = await open(at);
    const buffer = await packageBytes(at.vault);
    const full = path.join(at.root, 'Full');
    await mkdir(full); await writeFile(path.join(full, 'note.txt'), 'mine');
    for (const [target, message] of [
      [full, '其他檔案'], [path.join(at.vault, 'inside'), '目前的知識庫'], [path.join(at.profile, 'inside'), '程式資料目錄'],
      [at.root, '包含目前的知識庫'], ['relative/path', '完整路徑'],
    ] as const) {
      await expect(workspace.restore(buffer, target), target).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
      // A refused restore leaves the Vault unlocked.
      expect(() => workspace.enterWrite()()).not.toThrow();
    }
    expect(await readdir(full)).toEqual(['note.txt']);
    const empty = path.join(at.root, 'Empty');
    await mkdir(empty); await writeFile(path.join(empty, '.DS_Store'), '');
    await workspace.restore(buffer, empty); await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: empty });
    expect(await new MarkdownVault(empty).list()).toHaveLength(1);
  });

  it('suggests a free folder beside the Vault and leaves the chosen folder as it was when the restore fails', async () => {
    const at = await setup(); await seed(at.vault);
    const workspace = await open(at, { createSearch: async (destination) => {
      const search = fakeSearch(destination);
      if (destination !== at.vault) search.rebuild = async () => { throw new Error('index unavailable'); };
      return { search, close: async () => undefined };
    } });
    const suggestion = await workspace.suggestRestoreFolder();
    expect(path.dirname(suggestion)).toBe(at.root);
    expect(path.basename(suggestion)).toMatch(/^Vault 還原 \d{4}-\d{2}-\d{2}$/u);
    await mkdir(suggestion);
    await writeFile(path.join(suggestion, 'x'), '');
    expect(await workspace.suggestRestoreFolder()).toBe(`${suggestion} (2)`);
    const { suggestRestoreFolder } = await import('../../src/vault/transfer-files.js');
    // A restored Vault lends the name of the Vault it came from.
    expect(await suggestRestoreFolder(path.join(at.root, 'Vault 還原 2026-01-01 (3)'), new Date())).toBe(`${suggestion} (2)`);

    const empty = path.join(at.root, 'Empty');
    await mkdir(empty);
    await workspace.restore(await packageBytes(at.vault), empty); await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'error', vaultPath: at.vault });
    expect(await readdir(empty)).toEqual([]);
    expect((await readdir(at.root)).filter((name) => name.includes('restoring'))).toEqual([]);
    expect(existsSync(path.join(at.profile, RESTORE_JOURNAL))).toBe(false);
    expect(existsSync(path.join(at.profile, 'vault-selection.json'))).toBe(false);
  });

  it('removes only the staging folder a stopped restore recorded, before the Vault opens', async () => {
    const at = await setup(); await seed(at.vault);
    const staging = path.join(at.root, `Restored.restoring-${randomUUID()}`);
    await mkdir(path.join(staging, 'documents'), { recursive: true });
    await writeFile(path.join(staging, 'documents/partial.md'), 'partial');
    await mkdir(at.profile, { recursive: true });
    await writeFile(path.join(at.profile, RESTORE_JOURNAL), JSON.stringify({ staging }));
    await open(at);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(path.join(at.profile, RESTORE_JOURNAL))).toBe(false);

    // A journal naming any other folder is dropped without touching that folder.
    const other = path.join(at.root, 'Other');
    await mkdir(other); await writeFile(path.join(other, 'keep.md'), 'keep');
    await writeFile(path.join(at.profile, RESTORE_JOURNAL), JSON.stringify({ staging: other }));
    await workspaces.pop()!.close();
    await open(at);
    expect(await readdir(other)).toEqual(['keep.md']);
    expect(existsSync(path.join(at.profile, RESTORE_JOURNAL))).toBe(false);
  });
  it('refuses a folder reached through a symbolic link into the Vault or the profile', async () => {
    const at = await setup(); await seed(at.vault);
    await mkdir(at.profile, { recursive: true });
    const workspace = await open(at);
    const buffer = await packageBytes(at.vault);
    await symlink(at.vault, path.join(at.root, 'ToVault'));
    await symlink(at.profile, path.join(at.root, 'ToProfile'));
    for (const [target, message] of [
      [path.join(at.root, 'ToVault', 'restored'), '目前的知識庫'], [path.join(at.root, 'ToProfile', 'restored'), '程式資料目錄'],
    ] as const) {
      await expect(workspace.restore(buffer, target), target).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
    }
    expect(await readdir(at.vault)).not.toContain('restored');
    expect(await readdir(at.profile)).not.toContain('restored');
  });

  it('completes the switch when closing the previous Vault fails, and records its jobs as stopped by the switch', async () => {
    const at = await setup(); await seed(at.vault);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const workspace = await open(at, { jobLimits: { capture: 1 }, capture: { capture: async (video: { videoId: string; canonicalUrl: string }) => {
      started.push(video.videoId);
      if (started.length === 1) await waiting;
      return { ...capture, videoId: video.videoId, sourceUrl: video.canonicalUrl };
    } } });
    await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    const queued = await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=bbbbbbbbbbb');
    await expect.poll(() => started.length).toBe(1);
    // The previous Vault's scheduler and search fail to shut down.
    const previous = (workspace as unknown as { current: { schedule: { close(): Promise<void> }; runtime: { close(): Promise<void> } } }).current;
    previous.schedule.close = async () => { throw new Error('schedule close failed'); };
    previous.runtime.close = async () => { throw new Error('search close failed'); };
    const target = path.join(at.root, 'Restored');
    await workspace.restore(await packageBytes(at.vault), target);
    release(); await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: target, errorCode: null, result: { interruptedJobs: 1 } });
    expect(at.jobStore.get(queued.job.id)).toMatchObject({ state: 'interrupted', vaultPath: at.vault });
    expect(JSON.stringify(at.jobStore.get(queued.job.id))).toContain('切換到還原的知識庫');
    expect(() => workspace.enterWrite()()).not.toThrow();
  });

  it('takes back a restored folder a stop left after the rename, unless the selection names it', async () => {
    const at = await setup(); await seed(at.vault);
    await mkdir(at.profile, { recursive: true });
    const buffer = await packageBytes(at.vault);
    const target = path.join(at.root, 'Restored');
    const journalFile = path.join(at.profile, RESTORE_JOURNAL);
    async function stoppedAfterRename(createdBy = 'XR Collector test'): Promise<string> {
      await mkdir(target);
      await unpackBytes(buffer, target);
      await writeVaultMarker(target, createdBy);
      return (await markerDigest(target))!;
    }
    const journal = (marker: string) => JSON.stringify({ staging: `${target}.restoring-${randomUUID()}`, target, placed: true, marker, emptyTarget: true });

    await writeFile(journalFile, journal(await stoppedAfterRename()));
    await open(at);
    // The restore had replaced an empty folder, which comes back.
    expect(await readdir(target)).toEqual([]);
    expect(existsSync(journalFile)).toBe(false);
    await workspaces.pop()!.close();

    // A folder at the target that the restore did not write is left alone.
    await rm(target, { recursive: true });
    const marker = await stoppedAfterRename();
    await rm(path.join(target, 'xr-collector-vault.json'));
    await writeVaultMarker(target, 'another program');
    await writeFile(journalFile, journal(marker));
    await open(at);
    expect(await readdir(target)).toContain('documents');
    await workspaces.pop()!.close();

    // Once the selection names the restored Vault, the restore is complete and the folder stays.
    await rm(target, { recursive: true });
    await writeFile(journalFile, journal(await stoppedAfterRename()));
    await writeFile(path.join(at.profile, 'vault-selection.json'), JSON.stringify({ path: target }));
    const restored = await open(at);
    expect(restored.status().vaultPath).toBe(target);
    expect(await readdir(target)).toContain('documents');
    expect(existsSync(journalFile)).toBe(false);
  });
});

describe('cancelling a transfer that waits for collection (T4)', () => {
  it('ends the wait, writes nothing and returns to idle while collection goes on', async () => {
    const at = await setup(); await seed(at.vault);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const workspace = await open(at, { capture: { capture: async () => { await waiting; return capture; } } });
    expect(() => workspace.cancelWait()).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    const job = await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    await expect.poll(() => workspace.jobs.get(job.job.id)?.state).toBe('running');

    const file = path.join(at.root, 'cancelled.xr-vault');
    const exporting = workspace.exportTo(file);
    await expect.poll(() => workspace.status().state).toBe('waiting');
    expect(workspace.cancelWait()).toMatchObject({ state: 'idle', operation: null, message: '已取消，資料未變更。' });
    await expect(exporting).rejects.toMatchObject({ code: 'transfer_cancelled' });
    expect(existsSync(file)).toBe(false);
    expect(() => workspace.enterWrite()()).not.toThrow();

    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace });
    try {
      const target = path.join(at.root, 'Restored');
      const source = path.join(at.root, 'source.xr-vault');
      await writeFile(source, await packageBytes(at.vault));
      expect((await app.inject({ method: 'POST', url: '/api/vault/restore', payload: { packagePath: source, targetPath: target } })).statusCode).toBe(202);
      expect(workspace.status().state).toBe('waiting');
      const cancelled = await app.inject({ method: 'POST', url: '/api/vault/cancel' });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ state: 'idle', vaultPath: at.vault });
      await expect.poll(() => { try { workspace.enterWrite()(); return true; } catch { return false; } }).toBe(true);
      await expect.poll(() => existsSync(path.join(at.profile, RESTORE_JOURNAL))).toBe(false);
      expect(existsSync(target)).toBe(false);
      expect((await app.inject({ method: 'POST', url: '/api/vault/cancel' })).statusCode).toBe(400);
    } finally { await app.close(); }

    release();
    expect((await workspace.jobs.whenSettled(job.job.id)).state).toBe('completed');
    expect((await at.jobStore.activity.query({}, { vaultPath: at.vault })).events.filter((event) => event.eventType === 'vault.transfer_cancelled'))
      .toHaveLength(2);
  });
});

describe('export to a file (T6)', () => {
  it('writes the file whole, asks before replacing one and refuses places it does not belong', async () => {
    const at = await setup(); await seed(at.vault);
    await mkdir(at.profile, { recursive: true });
    const workspace = await open(at);
    expect(workspace.status().lastExportedAt).toBeNull();
    const file = path.join(at.root, 'backup.xr-vault');
    const status = await workspace.exportTo(file);
    expect(status).toMatchObject({ state: 'completed', operation: 'export', result: { exportPath: file, exportBytes: expect.any(Number) } });
    const written = await readFile(file);
    expect(written.length).toBe(status.result!.exportBytes);
    expect((await manifestOf(written)).summary).toEqual({ documents: 1, subscriptions: 1, deletions: 0 });
    expect(status.lastExportedAt).toBe((await manifestOf(written)).exportedAt);
    expect((await readdir(at.root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    await expect(workspace.exportTo(file)).rejects.toMatchObject({ code: 'file_exists', message: expect.stringContaining('已經存在') });
    await new MarkdownVault(at.vault).add({ ...capture, videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' });
    await workspace.exportTo(file, true);
    expect(((await manifestOf(await readFile(file))).summary as { documents: number }).documents).toBe(2);
    for (const [target, message] of [
      [path.join(at.vault, 'inside.xr-vault'), '目前的知識庫'], [path.join(at.profile, 'inside.xr-vault'), '程式資料目錄'],
      [path.join(at.root, 'backup.zip'), '.xr-vault'], [path.join(at.root, 'missing', 'b.xr-vault'), '資料夾不存在'],
      ['backup.xr-vault', '完整路徑'],
    ] as const) {
      await expect(workspace.exportTo(target), target).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
    }
    expect(await new Collector(new MarkdownVault(at.vault)).list()).toHaveLength(2);
  });

  it('remembers the last export of each Vault in the profile', async () => {
    const at = await setup(); await seed(at.vault);
    const workspace = await open(at);
    const { lastExportedAt } = await workspace.exportTo(path.join(at.root, 'a.xr-vault'));
    expect(JSON.parse(await readFile(path.join(at.profile, EXPORT_LOG), 'utf8'))).toEqual({ version: 1, vaults: { [at.vault]: lastExportedAt } });
    await workspace.close(); workspaces.pop();
    expect((await open(at)).status().lastExportedAt).toBe(lastExportedAt);
  });
});

describe('transfer by path over HTTP (T7)', () => {
  it('exports, previews and restores files named by path, for the app and an authorized Agent alike', async () => {
    const at = await setup(); await seed(at.vault);
    const workspace = await open(at);
    for (const agentToken of [undefined, 'test-token']) {
      const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, ...(agentToken ? { agentToken } : {}) });
      const headers = agentToken ? { authorization: `Bearer ${agentToken}` } : {};
      try {
        const file = path.join(at.root, `${agentToken ?? 'ui'}.xr-vault`);
        const exported = await app.inject({ method: 'POST', url: '/api/vault/export', headers, payload: { path: file } });
        expect(exported.statusCode).toBe(200);
        expect(exported.json()).toMatchObject({ state: 'completed', result: { exportPath: file } });
        const preview = await app.inject({ method: 'POST', url: '/api/vault/merge/preview', headers, payload: { path: file } });
        expect(preview.statusCode).toBe(200);
        expect(preview.json()).toMatchObject({ package: { createdBy: 'XR Collector test', exportedAt: expect.any(String) } });
        expect((await app.inject({ method: 'POST', url: '/api/vault/merge/cancel', headers, payload: { id: preview.json().id } })).statusCode).toBe(200);
        const missing = await app.inject({ method: 'POST', url: '/api/vault/merge/preview', headers, payload: { path: path.join(at.root, 'none.xr-vault') } });
        expect(missing.json()).toMatchObject({ error: { code: 'invalid_request', message: '找不到這個備份檔案。' } });
        const suggestion = await app.inject({ method: 'GET', url: '/api/vault/restore/suggestion', headers });
        expect(path.dirname(suggestion.json().path)).toBe(path.dirname(workspace.status().vaultPath));
        const target = path.join(at.root, `Restored-${agentToken ?? 'ui'}`);
        const restore = await app.inject({ method: 'POST', url: '/api/vault/restore', headers, payload: { packagePath: file, targetPath: target } });
        expect(restore.statusCode).toBe(202);
        await settled(workspace);
        expect((await app.inject({ method: 'GET', url: '/api/vault/status', headers })).json()).toMatchObject({ state: 'completed', vaultPath: target });
      } finally { await app.close(); }
    }
  });

  it('reports vault_busy in the status when a restore or merge outlasts the wait for collection', async () => {
    const at = await setup(); await seed(at.vault);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const workspace = await open(at, { holdTimeoutMs: 50, capture: { capture: async () => { await waiting; return capture; } } });
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace });
    try {
      const source = path.join(at.root, 'source.xr-vault');
      await writeFile(source, await packageBytes(at.vault));
      const preview = (await app.inject({ method: 'POST', url: '/api/vault/merge/preview', payload: { path: source } })).json();
      const job = await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=aaaaaaaaaaa');
      await expect.poll(() => workspace.jobs.get(job.job.id).state).toBe('running');

      const apply = await app.inject({ method: 'POST', url: '/api/vault/merge/apply', payload: { id: preview.id, choices: {} } });
      expect(apply.statusCode).toBe(202);
      await settled(workspace);
      expect((await app.inject({ method: 'GET', url: '/api/vault/status' })).json()).toMatchObject({
        state: 'error', operation: 'merge', errorCode: 'vault_busy',
      });
      const restore = await app.inject({ method: 'POST', url: '/api/vault/restore', payload: { packagePath: source, targetPath: path.join(at.root, 'Restored') } });
      expect(restore.statusCode).toBe(202);
      await settled(workspace);
      expect((await app.inject({ method: 'GET', url: '/api/vault/status' })).json()).toMatchObject({
        state: 'error', operation: 'restore', errorCode: 'vault_busy', vaultPath: at.vault,
      });
      // Export answers the request itself.
      expect((await app.inject({ method: 'POST', url: '/api/vault/export', payload: { path: path.join(at.root, 'late.xr-vault') } })).json())
        .toMatchObject({ error: { code: 'vault_busy' } });
    } finally {
      release();
      await app.close();
    }
  });

  it('keeps an earlier comparison when a new one is refused', async () => {
    const at = await setup(); await seed(at.vault);
    const workspace = await open(at);
    const preview = await workspace.previewMerge(await packageBytes(at.vault));
    const leave = workspace.enterWrite();
    await expect(workspace.previewMerge(await packageBytes(at.vault))).rejects.toMatchObject({ code: 'vault_busy' });
    leave();
    workspace.applyMerge(preview.id, {}); await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed', result: { writtenFiles: 0 } });
  });

  it('documents the path contract for Agents', async () => {
    const skill = await readFile(path.resolve('skills/xr-collector-agent/SKILL.md'), 'utf8');
    for (const term of ['"packagePath"', '"targetPath"', '`deletedOn`', 'autoCollectionPaused', '/api/vault/restore/suggestion', '`state: waiting`', 'overwrite',
      '`errorCode`', '/api/vault/cancel', '`file_exists`', '`transfer_cancelled`']) {
      expect(skill).toContain(term);
    }
  });
});

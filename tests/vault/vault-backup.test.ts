import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { EXPORT_LOG, RESTORE_JOURNAL } from '../../src/vault/transfer-files.js';
import { exportVault, packageInfo, unpackVault } from '../../src/vault/vault-package.js';
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
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function packageOf(files: { path: string; data: string }[], extra: Record<string, unknown> = {}) {
  const entries = files.map((file) => ({ path: file.path, data: Buffer.from(file.data).toString('base64'), size: Buffer.byteLength(file.data), sha256: sha(file.data) }));
  return Buffer.from(JSON.stringify({ format: 'xr-collector-vault', version: 3, ...extra, files: entries,
    sha256: sha(JSON.stringify(entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })))) }));
}

interface Setup { root: string; vault: string; profile: string; jobStore: JobStore }
async function setup(): Promise<Setup> {
  const root = await temp();
  return { root, vault: path.join(root, 'Vault'), profile: path.join(root, 'profile'), jobStore: JobStore.memory() };
}
async function open(at: Setup, overrides: Partial<Parameters<typeof VaultWorkspace.open>[0]> = {}) {
  const selection = new VaultSelection(path.join(at.profile, 'vault-selection.json'));
  const workspace = await VaultWorkspace.open({
    root: await selection.read() ?? at.vault, selection, profilePath: at.profile, createdBy: 'XR Collector test',
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
  it('describes a package for people without changing what makes it valid', async () => {
    const at = await setup(); await seed(at.vault);
    const workspace = await open(at);
    const described = await workspace.export();
    expect(packageInfo(described)).toMatchObject({
      version: 3, createdBy: 'XR Collector test', exportedAt: expect.any(String), summary: { documents: 1, subscriptions: 1, deletions: 0 },
    });
    // Packages written for comparisons carry no description, so equal data gives equal bytes.
    const plain = await exportVault(at.vault);
    expect(packageInfo(plain)).toEqual({ version: 3, summary: { documents: 1, subscriptions: 1, deletions: 0 } });
    expect(JSON.parse(plain.toString()).files).toEqual(JSON.parse(described.toString()).files);
    // A reader ignores top-level fields it does not know.
    const extended = JSON.stringify({ ...JSON.parse(described.toString()), laterField: { any: 'value' } });
    await expect(unpackVault(Buffer.from(extended), path.join(at.root, 'unpacked'), () => undefined)).resolves.toBeUndefined();
  });

  it('keeps fields it does not know through a restore', async () => {
    const at = await setup(); await seed(at.vault);
    const markdown = await readFile(path.join(at.vault, `documents/youtube/${capture.videoId}.md`), 'utf8');
    const row = { id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
      settings, nextCheckAt: null, lastDispatchedAt: null, laterRowField: 'row' };
    const buffer = packageOf([
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
    await expect(unpackVault(packageOf([{ path: 'settings/future.json', data: '{}' }]), path.join(at.root, 'x'), () => undefined))
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
    await workspace.restore(await exportVault(at.vault), target);
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
    const buffer = await exportVault(at.vault);
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
    await workspace.restore(await exportVault(at.vault), empty); await settled(workspace);
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
    expect(packageInfo(written).summary).toEqual({ documents: 1, subscriptions: 1, deletions: 0 });
    expect(status.lastExportedAt).toBe(packageInfo(written).exportedAt);
    expect((await readdir(at.root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    await expect(workspace.exportTo(file)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('已經存在') });
    await new MarkdownVault(at.vault).add({ ...capture, videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' });
    await workspace.exportTo(file, true);
    expect(packageInfo(await readFile(file)).summary?.documents).toBe(2);
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
        expect(preview.json()).toMatchObject({ package: { version: 3, createdBy: 'XR Collector test' } });
        expect((await app.inject({ method: 'POST', url: '/api/vault/merge/cancel', headers, payload: { id: preview.json().id } })).statusCode).toBe(200);
        const missing = await app.inject({ method: 'POST', url: '/api/vault/merge/preview', headers, payload: { path: path.join(at.root, 'none.xr-vault') } });
        expect(missing.json()).toMatchObject({ error: { code: 'invalid_request', message: '找不到這個資料包檔案。' } });
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

  it('documents the path contract for Agents', async () => {
    const skill = await readFile(path.resolve('skills/xr-collector-agent/SKILL.md'), 'utf8');
    for (const term of ['"packagePath"', '"targetPath"', '`deletedOn`', 'autoCollectionPaused', '/api/vault/restore/suggestion', '`state: waiting`', 'overwrite']) {
      expect(skill).toContain(term);
    }
  });
});

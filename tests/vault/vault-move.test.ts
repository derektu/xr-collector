import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectionJob, SavedDocument, TranscriptSearch } from '../../src/core/types.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { createVaultDirectory, readVaultId, VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { checkMoveTarget, MOVE_JOURNAL, previousLocations, recordPreviousLocation } from '../../src/vault/vault-move.js';
import { inspectVaultDirectory } from '../../src/vault/vault-directory.js';
import { packageBytes, packageFiles } from './package-fixtures.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { checkImportFolder } from '../../src/vault/transfer-files.js';
import { importNewVault } from '../../src/vault/vault-import.js';
import { subscriptionCollections, VaultWorkspace, type MoveFault, type WorkspaceOptions } from '../../src/vault/workspace.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { withYouTube, type YouTubeTestSources } from '../support/youtube-sources.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';

const roots: string[] = [];
const workspaces: VaultWorkspace[] = [];
const stores: JobStore[] = [];
const restore: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of restore.splice(0)) await undo();
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-move-'));
  roots.push(root);
  return root;
}

const video = (id: string): CapturedTranscript => ({
  videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}`, title: `搬移測試 ${id}`, channelId: 'UC123', channelTitle: '測試頻道',
  publishedAt: null, languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual', bodyMarkdown: `森林觀測 ${id}`,
});
const urlOf = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const IDS = ['move0000001', 'move0000002', 'move0000003', 'move0000004'];

async function seed(root: string): Promise<void> {
  await createVaultDirectory(root, 'XR Collector test');
  await new MarkdownVault(root).add(transcriptDocument(video('seed0000001')));
  await new JsonSubscriptionStore(root, 'youtube').add({
    id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
    settings: { intervalMinutes: 60, backfillWindow: '1m', backfillMaxItems: 10 }, nextCheckAt: '2099-01-01T00:00:00.000Z', lastDispatchedAt: null,
  });
  await mkdir(path.join(root, 'attachments'), { recursive: true });
  await writeFile(path.join(root, 'attachments/sample.bin'), Buffer.from([0, 1, 128, 255]));
  await mkdir(path.join(root, '.obsidian'), { recursive: true });
  await writeFile(path.join(root, '.obsidian/workspace.json'), '{"使用者":"自訂設定"}');
  await mkdir(path.join(root, 'empty folder'));
}

/** Every folder and file under `root`, with a digest of each file. */
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (relative: string) => {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const info = await lstat(path.join(root, child));
      if (info.isDirectory()) { result[child] = 'dir'; await walk(child); }
      else result[child] = createHash('sha256').update(await readFile(path.join(root, child))).digest('hex');
    }
  };
  await walk('');
  return result;
}

function fakeSearch(root: string, failRebuild = false): TranscriptSearch {
  let docs: SavedDocument[] = [];
  return {
    status: () => ({ state: 'ready', indexedDocuments: docs.length }),
    async index(doc) { docs.push(doc); },
    async remove(id) { docs = docs.filter((doc) => doc.id !== id); },
    async rebuild() {
      if (failRebuild) throw new Error('index unavailable');
      const vault = new MarkdownVault(root);
      docs = (await Promise.all((await vault.list()).map(({ id }) => vault.read(id)))).filter((doc): doc is SavedDocument => !!doc);
    },
    async search({ query }) {
      const hits = docs.filter((doc) => doc.bodyMarkdown.includes(query)).map((doc) => ({ ...doc, snippet: doc.bodyMarkdown }));
      return { hits, total: hits.length, offset: 0, limit: 50 };
    },
  };
}

/** A capture that waits at `gate` for the videos named in `held`, and records the order videos start in. */
function gatedCapture(held: Set<string> = new Set()) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const started: string[] = [];
  return {
    started, open,
    capture: { capture: async (target: { videoId: string; canonicalUrl: string }) => {
      started.push(target.videoId);
      if (held.has(target.videoId)) await gate;
      return video(target.videoId);
    } },
  };
}

interface Setup {
  root: string;
  source: string;
  profile: string;
  selection: VaultSelection;
  jobsDir: string;
}

async function setup(sourceName = 'Vault'): Promise<Setup> {
  const root = await temp();
  const source = path.join(root, sourceName);
  await mkdir(path.dirname(source), { recursive: true });
  await seed(source);
  const profile = path.join(root, 'profile');
  return { root, source, profile, selection: new VaultSelection(path.join(profile, 'vault-selection.json')), jobsDir: path.join(profile, 'jobs') };
}

/** Opens the Vault the device selection names (the source when none), as the runtime does at startup. */
async function open(context: Setup, overrides: Partial<WorkspaceOptions> & YouTubeTestSources = {}, track = true): Promise<VaultWorkspace> {
  const jobStore = overrides.jobStore ?? await JobStore.open(context.jobsDir);
  if (track && !overrides.jobStore) stores.push(jobStore);
  const workspace = await VaultWorkspace.open(withYouTube({
    root: await context.selection.read() ?? context.source, selection: context.selection, profilePath: context.profile,
    createdBy: 'XR Collector test', capture: { capture: async (target) => video(target.videoId) },
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: '', searchData: path.join(context.profile, 'search'), exportFolder: path.join(context.root, 'exports'), backupFolder: path.join(context.root, 'backups'),
    createSearch: async (destination) => ({ search: fakeSearch(destination), close: async () => undefined }),
    jobStore, jobLimits: { capture: 1 },
    ...overrides,
  }));
  if (track) workspaces.push(workspace);
  return workspace;
}

async function settled(workspace: VaultWorkspace): Promise<void> {
  await expect.poll(() => workspace.status().state, { timeout: 10_000 }).toMatch(/^(completed|error)$/u);
}

async function leftovers(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => /\.(moving|moved)-/u.test(name));
}

const jobOf = (workspace: VaultWorkspace, id: string): CollectionJob => workspace.jobs.get(id);

describe('move target checks (A-01)', () => {
  it('refuses unsafe locations before anything stops, and accepts free ones', async () => {
    const context = await setup();
    const { root, source } = context;
    const gated = gatedCapture(new Set([IDS[0]!]));
    const workspace = await open(context, { capture: gated.capture });
    const running = await workspace.jobs.submitItem('youtube', urlOf(IDS[0]!));
    await expect.poll(() => gated.started.length).toBe(1);
    await createVaultDirectory(path.join(root, 'Other'), 'XR Collector test');
    await mkdir(path.join(root, 'Full')); await writeFile(path.join(root, 'Full/note.txt'), '使用者的檔案');
    await mkdir(path.join(root, 'Empty'));
    await symlink(source, path.join(root, 'Alias'));
    await symlink(path.join(root, 'Empty'), path.join(root, 'EmptyLink'));
    await mkdir(path.join(root, 'Locked'), { mode: 0o555 });
    restore.push(() => chmod(path.join(root, 'Locked'), 0o755));
    const before = await readdir(root);
    const cases: [string, string, string][] = [
      ['relative/path', 'invalid_request', '完整路徑'],
      [source, 'invalid_request', '就是目前的知識庫'],
      [path.join(source, 'inside'), 'invalid_request', '目前的知識庫裡'],
      [path.join(root, 'Alias', 'inside'), 'invalid_request', '目前的知識庫裡'],
      [path.join(root, 'EmptyLink'), 'invalid_request', '符號連結'],
      [root, 'invalid_request', '包含目前的知識庫'],
      [path.join(root, 'Other'), 'invalid_request', '另一個知識庫'],
      [path.join(root, 'Other', 'nested'), 'invalid_request', '另一個知識庫裡'],
      [path.join(root, 'Full'), 'invalid_request', '已經有內容'],
      [path.join(context.profile, 'moved'), 'invalid_request', '程式資料目錄'],
      [path.join(root, 'missing', 'deeper'), 'invalid_request', '上層目錄也不存在'],
    ];
    if (process.getuid?.() !== 0) cases.push([path.join(root, 'Locked', 'Vault'), 'invalid_request', '沒有權限']);
    for (const [target, code, message] of cases) {
      await expect(workspace.move(target), target).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
    }
    const tiny = await open({ ...context }, { statfs: async () => ({ bavail: 10, bsize: 4096 }) }, false);
    await expect(tiny.checkMove(path.join(root, 'Moved'))).rejects.toMatchObject({ code: 'insufficient_space', message: expect.stringContaining('磁碟空間不足') });
    expect(workspace.status()).toMatchObject({ state: 'idle', operation: null });
    expect(await readdir(root)).toEqual(before);
    expect(jobOf(workspace, running.job.id).state).toBe('running');
    // Free locations: a missing folder in an existing one, and an empty folder holding only system files.
    await writeFile(path.join(root, 'Empty/.DS_Store'), '');
    const check = await workspace.checkMove(path.join(root, 'Empty'));
    expect(check.targetPath).toBe(path.join(root, 'Empty'));
    expect(check.requiredBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    await expect(workspace.checkMove(path.join(root, 'New Place'))).resolves.toMatchObject({ targetPath: path.join(root, 'New Place') });
    gated.open();
    await workspace.jobs.whenSettled(running.job.id);
  });

  it('compares locations after resolving them, so another spelling on a case-insensitive volume is the same folder', async () => {
    const context = await setup();
    const { source, profile } = context;
    const lower = path.join(path.dirname(source), path.basename(source).toLowerCase());
    // Stands for a case-insensitive volume on any file system: the lower-case spelling resolves to the Vault.
    const real = async (target: string) => target.toLowerCase() === source.toLowerCase() ? realpath(source) : realpath(target);
    const folders = { vaultRoot: source, profilePath: profile };
    await expect(checkMoveTarget(lower, folders, 0, { real })).rejects.toMatchObject({ message: expect.stringContaining('就是目前的知識庫') });
    await expect(checkMoveTarget(path.join(lower, 'inside'), folders, 0, { real }))
      .rejects.toMatchObject({ message: expect.stringContaining('目前的知識庫裡') });
  });

  it('refuses a location whose real ancestors include another Vault, and working folders of a move or import', async () => {
    const context = await setup();
    const { root } = context;
    await createVaultDirectory(path.join(root, 'Other'), 'XR Collector test');
    await mkdir(path.join(root, 'Other', 'sub'));
    await symlink(path.join(root, 'Other', 'sub'), path.join(root, 'LinkSub'));
    const workspace = await open(context);
    await expect(workspace.checkMove(path.join(root, 'LinkSub', 'New'))).rejects.toMatchObject({ message: expect.stringContaining('另一個知識庫裡') });
    const working = path.join(root, 'Vault.moved-00000000-0000-4000-8000-000000000000');
    await expect(workspace.checkMove(working)).rejects.toMatchObject({ message: expect.stringContaining('暫存資料夾') });
    await expect(checkImportFolder(path.join(root, 'X.importing-00000000-0000-4000-8000-000000000000')))
      .rejects.toMatchObject({ message: expect.stringContaining('暫存資料夾') });
    expect(workspace.status().vaultPath).toBe(context.source);
  });

  it('answers vault_busy while an operation runs, reports file system failures as a refused location, and reuses the Vault size', async () => {
    const context = await setup();
    const target = path.join(context.root, 'Moved');
    const gated = gatedCapture(new Set([IDS[0]!]));
    let failStatfs = false;
    const workspace = await open(context, {
      capture: gated.capture,
      statfs: async (folder) => {
        if (failStatfs) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return { bavail: 1_000_000, bsize: 4096, folder } as never;
      },
    });
    const first = await workspace.checkMove(target);
    await writeFile(path.join(context.source, 'attachments', 'large.bin'), Buffer.alloc(32 * 1024 * 1024));
    expect((await workspace.checkMove(target)).requiredBytes).toBe(first.requiredBytes);
    failStatfs = true;
    const app = await createHttpApp({ transfer: workspace });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/vault/move/check', payload: { targetPath: target } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_request');
    } finally { await app.close(); }
    failStatfs = false;
    const job = await workspace.jobs.submitItem('youtube', urlOf(IDS[0]!));
    await expect.poll(() => gated.started.length).toBe(1);
    await workspace.move(target);
    await expect(workspace.checkMove(path.join(context.root, 'Elsewhere'))).rejects.toMatchObject({ code: 'vault_busy' });
    workspace.cancelWait();
    gated.open();
    await workspace.jobs.whenSettled(job.job.id);
  });

  it('refuses a Vault holding a symbolic link', async () => {
    const context = await setup();
    await symlink(path.join(context.root, 'outside'), path.join(context.source, 'attachments', 'link'));
    const workspace = await open(context);
    await expect(workspace.move(path.join(context.root, 'Moved'))).rejects.toMatchObject({ message: expect.stringContaining('attachments/link') });
    expect(workspace.status().state).toBe('idle');
  });
});

describe('moving a Vault', () => {
  it('copies every file, verifies it, switches and removes the original (A-02)', async () => {
    const context = await setup();
    const { root, source } = context;
    const target = path.join(root, 'Moved', 'XR Collector');
    await mkdir(path.dirname(target));
    const workspace = await open(context);
    await workspace.exportTo();
    const id = await readVaultId(source);
    const before = await tree(source);
    expect(workspace.status().relocationUnavailable).toBeNull();
    const accepted = await workspace.move(target);
    expect(accepted).toMatchObject({ operation: 'move' });
    await settled(workspace);
    expect(workspace.status()).toMatchObject({
      state: 'completed', operation: 'move', vaultPath: target,
      result: { previousVaultPath: source, resumedJobs: 0 }, message: expect.stringContaining('原位置已清除'),
    });
    expect(await tree(target)).toEqual(before);
    expect(await readVaultId(target)).toBe(id);
    expect(existsSync(source)).toBe(false);
    expect(await leftovers(root)).toEqual([]);
    expect(await leftovers(path.dirname(target))).toEqual([]);
    expect(await context.selection.read()).toBe(target);
    expect(existsSync(path.join(context.profile, MOVE_JOURNAL))).toBe(false);
    expect((await workspace.collector.list()).map((doc) => doc.id)).toEqual(['youtube:seed0000001']);
    expect((await workspace.search.search({ query: '森林觀測' })).hits.map((hit) => hit.id)).toEqual(['youtube:seed0000001']);
    await workspace.close();
    workspaces.splice(workspaces.indexOf(workspace), 1);
    const reopened = await open(context, { jobStore: stores[0]! });
    expect(reopened.status().vaultPath).toBe(target);
  });

  it('stops dispatching, waits only for the running step, and continues the queue at the new location (A-03, A-09)', async () => {
    const context = await setup();
    const { root, source } = context;
    const target = path.join(root, 'Moved');
    const gated = gatedCapture(new Set([IDS[0]!]));
    let atCopied!: () => void;
    let resumeCopy!: () => void;
    const copied = new Promise<void>((resolve) => { atCopied = resolve; });
    const proceed = new Promise<void>((resolve) => { resumeCopy = resolve; });
    const workspace = await open(context, {
      capture: gated.capture,
      moveFaults: async (phase) => { if (phase === 'copied') { atCopied(); await proceed; } },
    });
    const jobStore = stores[0]!;
    jobStore.event({ severity: 'info', eventType: 'test.legacy', message: '搬移前沒有 Vault ID 的記錄', vaultPath: source, jobId: null });
    const jobs = [];
    for (const id of IDS) jobs.push((await workspace.jobs.submitItem('youtube', urlOf(id))).job.id);
    await expect.poll(() => gated.started).toEqual([IDS[0]]);
    const app = await createHttpApp({ collector: workspace.collector, jobs: workspace.jobs, search: workspace.search, transfer: workspace, schedule: workspace.schedule, subscriptions: subscriptionCollections(() => workspace.subscriptions) });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/vault/move', payload: { targetPath: target } });
      expect(response.statusCode).toBe(202);
      expect(workspace.status()).toMatchObject({ state: 'waiting', operation: 'move' });
      gated.open();
      await copied;
      // While the copy is checked, reads go on and every write waits for the move.
      const refused = await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: urlOf('late0000001') } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain('正在搬移知識庫');
      expect((await app.inject({ method: 'POST', url: '/api/youtube/channels/run', payload: {} })).statusCode).toBe(409);
      expect((await app.inject('/api/documents')).statusCode).toBe(200);
      expect((await app.inject('/api/search?q=森林')).statusCode).toBe(200);
      expect((await app.inject('/api/jobs')).statusCode).toBe(200);
      expect(gated.started).toEqual([IDS[0]]);
      expect(jobOf(workspace, jobs[1]!).state).toBe('queued');
      resumeCopy();
      await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: target, result: { resumedJobs: 3 } });
      for (const id of jobs) expect((await workspace.jobs.whenSettled(id)).state).toBe('completed');
      expect(gated.started).toEqual(IDS);
      const listed = workspace.jobs.list({ state: 'all' }).jobs;
      expect(listed.map((job) => job.id).sort()).toEqual([...jobs].sort());
      expect(listed.every((job) => job.vaultPath === target)).toBe(true);
      expect((await workspace.collector.list()).map((doc) => doc.id).sort()).toEqual(
        ['youtube:seed0000001', ...IDS.map((id) => `youtube:${id}`)].sort());
      expect(existsSync(source)).toBe(false);
      expect((await app.inject({ method: 'POST', url: '/api/youtube/collect', payload: { url: urlOf('late0000001') } })).statusCode).toBe(202);
      // Activity of the moved Vault, including what was recorded at the previous location.
      await jobStore.flush();
      const events = (await jobStore.activity.query({ limit: 200 }, workspace.activityScope())).events;
      const types = events.map((event) => event.eventType);
      for (const type of ['test.legacy', 'job.accepted', 'vault.move_started', 'vault.moved', 'job.resumed']) expect(types).toContain(type);
      expect(events.filter((event) => event.eventType === 'job.interrupted').every((event) => event.severity === 'info')).toBe(true);
      expect(events.find((event) => event.eventType === 'job.resumed')!.message).toContain('搬移完成');
      expect(await previousLocations(context.profile, await readVaultId(target))).toEqual([source]);
    } finally { await app.close(); }
  });

  it('gives up when a running step outlasts the hold, and a cancelled wait changes nothing (A-04)', async () => {
    const context = await setup();
    const target = path.join(context.root, 'Moved');
    const gated = gatedCapture(new Set([IDS[0]!]));
    const workspace = await open(context, { capture: gated.capture, holdTimeoutMs: 50 });
    const job = await workspace.jobs.submitItem('youtube', urlOf(IDS[0]!));
    await expect.poll(() => gated.started.length).toBe(1);
    await workspace.move(target);
    await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'error', errorCode: 'vault_busy', vaultPath: context.source, message: expect.stringContaining('仍在原位置') });
    expect(existsSync(target)).toBe(false);
    expect(() => workspace.enterWrite()()).not.toThrow();
    gated.open();
    expect((await workspace.jobs.whenSettled(job.job.id)).state).toBe('completed');

    const other = await setup();
    const held = gatedCapture(new Set([IDS[1]!]));
    const waiting = await open(other, { capture: held.capture });
    const pending = await waiting.jobs.submitItem('youtube', urlOf(IDS[1]!));
    await expect.poll(() => held.started.length).toBe(1);
    await waiting.move(path.join(other.root, 'Moved'));
    expect(waiting.status().state).toBe('waiting');
    expect(waiting.cancelWait()).toMatchObject({ state: 'idle', message: expect.stringContaining('已取消') });
    held.open();
    expect((await waiting.jobs.whenSettled(pending.job.id)).state).toBe('completed');
    await expect.poll(() => waiting.status().vaultPath).toBe(other.source);
    expect(existsSync(path.join(other.root, 'Moved'))).toBe(false);
    expect(await leftovers(other.root)).toEqual([]);
  });
});

describe('a move that fails before the switch (A-05)', () => {
  const cases: { name: string; phase?: MoveFault; tamper?: boolean; emptyTarget?: boolean; failIndex?: boolean; failSelection?: boolean }[] = [
    { name: 'copy error', phase: 'copying' },
    { name: 'a copied file that differs', tamper: true },
    { name: 'error after verification', phase: 'verified', emptyTarget: true },
    { name: 'error after placing the copy', phase: 'placed', emptyTarget: true },
    { name: 'search index failure', failIndex: true },
    { name: 'error just before the switch', phase: 'committing' },
    { name: 'selection write failure', failSelection: true },
  ];
  it.each(cases)('keeps the original and its work after $name', async ({ phase, tamper, emptyTarget, failIndex, failSelection }) => {
    const context = await setup();
    const { root, source } = context;
    const target = path.join(root, 'Moved');
    if (emptyTarget) await mkdir(target);
    const gated = gatedCapture(new Set([IDS[0]!]));
    const selection = failSelection
      ? new (class extends VaultSelection { override async write(value: string) { if (value === target) throw new Error('disk full'); return super.write(value); } })(context.selection.file)
      : context.selection;
    const workspace = await open({ ...context, selection }, {
      capture: gated.capture,
      moveFaults: async (current) => {
        if (tamper && current === 'copied') {
          const staging = (await readdir(root)).find((name) => name.includes('.moving-'))!;
          await writeFile(path.join(root, staging, '.obsidian/workspace.json'), '改過的內容');
        }
        if (current === phase) throw Object.assign(new Error('EIO: simulated failure'), { code: 'EIO' });
      },
      createSearch: async (destination) => ({ search: fakeSearch(destination, Boolean(failIndex) && destination === target), close: async () => undefined }),
    });
    const before = await tree(source);
    const first = await workspace.jobs.submitItem('youtube', urlOf(IDS[0]!));
    const queued = await workspace.jobs.submitItem('youtube', urlOf(IDS[1]!));
    await expect.poll(() => gated.started.length).toBe(1);
    await workspace.move(target);
    gated.open();
    await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'error', operation: 'move', vaultPath: source, message: expect.stringContaining(`仍在原位置 ${source}`) });
    expect((await workspace.jobs.whenSettled(queued.job.id)).state).toBe('completed');
    await workspace.jobs.whenSettled(first.job.id);
    const after = await tree(source);
    for (const id of IDS.slice(0, 2)) delete after[`documents/youtube/${id}.md`];
    expect(after).toEqual(before);
    expect(await context.selection.read()).toBeNull();
    expect(await leftovers(root)).toEqual([]);
    if (emptyTarget) expect(await readdir(target)).toEqual([]);
    else expect(existsSync(target)).toBe(false);
    expect(existsSync(path.join(context.profile, MOVE_JOURNAL))).toBe(false);
    const events = (await stores[0]!.activity.query({}, workspace.activityScope())).events;
    expect(events.map((event) => event.eventType)).toContain('vault.move_failed');
    // The original keeps working and the move can be tried again.
    expect(() => workspace.enterWrite()()).not.toThrow();
  });
});

describe('a move interrupted by a stop (A-06)', () => {
  it.each(['copying', 'placed', 'prepared', 'selected', 'committed', 'cleaning'] as MoveFault[])('finishes or takes back a move stopped at %s', async (phase) => {
    const context = await setup();
    const { root, source } = context;
    const target = path.join(root, 'Moved');
    const gated = gatedCapture(new Set([IDS[0]!]));
    let reached!: () => void;
    const stopped = new Promise<void>((resolve) => { reached = resolve; });
    const jobStore = await JobStore.open(context.jobsDir);
    const first = await open(context, {
      jobStore, capture: gated.capture,
      moveFaults: async (current) => { if (current === phase) { reached(); await new Promise(() => undefined); } },
    }, false);
    const running = await first.jobs.submitItem('youtube', urlOf(IDS[0]!));
    const queued = await first.jobs.submitItem('youtube', urlOf(IDS[1]!));
    await expect.poll(() => gated.started.length).toBe(1);
    await first.move(target);
    gated.open();
    await first.jobs.whenSettled(running.job.id).catch(() => undefined);
    await stopped;
    if (phase === 'cleaning') await first.jobs.whenSettled(queued.job.id);
    await jobStore.flush();
    // The process ends here; the next start reads only what reached the disk.
    // `selected`: the selection names the new location while the journal still says `placed`.
    const committed = phase === 'selected' || phase === 'committed' || phase === 'cleaning';
    const restarted = await open(context);
    expect(restarted.status().vaultPath).toBe(committed ? target : source);
    expect(existsSync(path.join(context.profile, MOVE_JOURNAL))).toBe(false);
    expect(await leftovers(root)).toEqual([]);
    expect(existsSync(committed ? source : target)).toBe(false);
    expect((await restarted.jobs.whenSettled(queued.job.id)).state).toBe('completed');
    expect(restarted.jobs.get(queued.job.id).vaultPath).toBe(committed ? target : source);
    expect(await new MarkdownVault(committed ? target : source).read(`youtube:${IDS[1]}`)).not.toBeNull();
  });

  it('leaves folders alone when the journal names something the move did not create', async () => {
    const context = await setup();
    const other = path.join(context.root, 'Someone else');
    await mkdir(other);
    await writeFile(path.join(other, 'keep.txt'), '不是搬移建立的');
    await mkdir(context.profile, { recursive: true });
    await writeFile(path.join(context.profile, MOVE_JOURNAL), JSON.stringify({
      version: 1, vaultId: await readVaultId(context.source), source: context.source, target: other,
      staging: `${other}.moving-00000000-0000-4000-8000-000000000000`, phase: 'placed', marker: 'f'.repeat(64), emptyTarget: false, removal: null,
    }));
    const workspace = await open(context);
    expect(workspace.status().vaultPath).toBe(context.source);
    expect(await readFile(path.join(other, 'keep.txt'), 'utf8')).toBe('不是搬移建立的');
    expect(existsSync(path.join(context.profile, MOVE_JOURNAL))).toBe(false);
  });
});

describe('cleaning the original location after the switch (A-07)', () => {
  it('reports a location it cannot remove, keeps the new Vault, and removes it on a later start', async () => {
    const context = await setup(path.join('Parent', 'Vault'));
    const parent = path.dirname(context.source);
    const target = path.join(context.root, 'Moved');
    const workspace = await open(context);
    await chmod(parent, 0o555);
    restore.push(() => chmod(parent, 0o755));
    await workspace.move(target);
    await settled(workspace);
    expect(workspace.status()).toMatchObject({
      state: 'completed', vaultPath: target, result: { leftoverPath: context.source }, message: expect.stringContaining('未能清除'),
    });
    expect(await context.selection.read()).toBe(target);
    expect(existsSync(path.join(context.source, VAULT_MARKER))).toBe(true);
    const events = (await stores[0]!.activity.query({}, workspace.activityScope())).events;
    expect(events.find((event) => event.eventType === 'vault.move_cleanup_failed')).toMatchObject({ severity: 'warning' });
    await workspace.close(); workspaces.splice(workspaces.indexOf(workspace), 1);
    await chmod(parent, 0o755);
    const reopened = await open(context, { jobStore: stores[0]! });
    expect(reopened.status().vaultPath).toBe(target);
    expect(existsSync(context.source)).toBe(false);
    expect(await leftovers(parent)).toEqual([]);
  });

  it('reports the removal folder when deleting it fails part way, and deletes it on a later start', async () => {
    const context = await setup();
    const target = path.join(context.root, 'Moved');
    const workspace = await open(context, { moveFaults: (phase) => { if (phase === 'cleaning') throw new Error('EBUSY'); } });
    await workspace.move(target);
    await settled(workspace);
    const leftover = workspace.status().result?.leftoverPath;
    expect(leftover).toMatch(/\.moved-[0-9a-f-]{36}$/u);
    expect(existsSync(context.source)).toBe(false);
    expect(existsSync(leftover!)).toBe(true);
    await workspace.close(); workspaces.splice(workspaces.indexOf(workspace), 1);
    const reopened = await open(context, { jobStore: stores[0]! });
    expect(reopened.status().vaultPath).toBe(target);
    expect(existsSync(leftover!)).toBe(false);
  });
});

describe('an original location that is in use again', () => {
  it('keeps a leftover original opened again, with its new documents and jobs, through switches and restarts', async () => {
    const context = await setup(path.join('Parent', 'Vault'));
    const { source } = context;
    const parent = path.dirname(source);
    const target = path.join(context.root, 'Moved');
    const jobStore = await JobStore.open(context.jobsDir);
    stores.push(jobStore);
    let workspace = await open(context, { jobStore }, false);
    await chmod(parent, 0o555);
    restore.push(() => chmod(parent, 0o755));
    await workspace.move(target);
    await settled(workspace);
    expect(workspace.status().result?.leftoverPath).toBe(source);
    await chmod(parent, 0o755);
    // The person opens the leftover original again and keeps collecting there.
    await workspace.openOther(source);
    await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: source });
    expect(existsSync(path.join(context.profile, MOVE_JOURNAL))).toBe(false);
    const added = await workspace.jobs.submitItem('youtube', urlOf(IDS[2]!));
    expect((await workspace.jobs.whenSettled(added.job.id)).state).toBe('completed');
    await workspace.openOther(target);
    await settled(workspace);
    await workspace.close();
    workspace = await open(context, { jobStore }, false);
    expect(workspace.status().vaultPath).toBe(target);
    await workspace.openOther(source);
    await settled(workspace);
    await workspace.close();
    workspace = await open(context, { jobStore });
    expect(workspace.status().vaultPath).toBe(source);
    expect(await new MarkdownVault(source).read(`youtube:${IDS[2]}`)).not.toBeNull();
    expect(workspace.jobs.get(added.job.id)).toMatchObject({ state: 'completed', vaultPath: source });
    expect(existsSync(path.join(source, VAULT_MARKER))).toBe(true);
  });

  it('refuses to open the removal folder of a move', async () => {
    const context = await setup();
    const workspace = await open(context, { moveFaults: (phase) => { if (phase === 'cleaning') throw new Error('EBUSY'); } });
    await workspace.move(path.join(context.root, 'Moved'));
    await settled(workspace);
    const leftover = workspace.status().result!.leftoverPath!;
    await expect(workspace.openOther(leftover)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('暫存資料夾') });
    expect(workspace.status().state).toBe('completed');
    expect(existsSync(leftover)).toBe(true);
  });

  it('drops a committed journal whose original is the selected Vault, without moving jobs or deleting it', async () => {
    const context = await setup();
    const { source, root } = context;
    const target = path.join(root, 'Moved');
    await cp(source, target, { recursive: true });
    const jobStore = await JobStore.open(context.jobsDir);
    stores.push(jobStore);
    const gated = gatedCapture(new Set([IDS[0]!]));
    const first = await open(context, { jobStore, capture: gated.capture }, false);
    await first.jobs.submitItem('youtube', urlOf(IDS[0]!));
    const left = await first.jobs.submitItem('youtube', urlOf(IDS[1]!));
    await expect.poll(() => gated.started.length).toBe(1);
    gated.open();
    await first.close();
    await context.selection.write(source);
    await writeFile(path.join(context.profile, MOVE_JOURNAL), JSON.stringify({
      version: 1, vaultId: await readVaultId(source), source, target, staging: `${target}.moving-00000000-0000-4000-8000-000000000000`,
      phase: 'switched', marker: null, emptyTarget: false, removal: null,
    }));
    const reopened = await open(context, { jobStore });
    expect(reopened.status().vaultPath).toBe(source);
    expect(existsSync(path.join(source, VAULT_MARKER))).toBe(true);
    expect(existsSync(path.join(context.profile, MOVE_JOURNAL))).toBe(false);
    expect((await reopened.jobs.whenSettled(left.job.id)).vaultPath).toBe(source);
  });

  it('finishes removing an original whose rename to the removal name never happened, and reports one it cannot remove', async () => {
    for (const locked of [false, true]) {
      const context = await setup(path.join('Parent', 'Vault'));
      const { source, root } = context;
      const target = path.join(root, 'Moved');
      await cp(source, target, { recursive: true });
      await context.selection.write(target);
      await mkdir(context.profile, { recursive: true });
      await writeFile(path.join(context.profile, MOVE_JOURNAL), JSON.stringify({
        version: 1, vaultId: await readVaultId(source), source, target, staging: `${target}.moving-00000000-0000-4000-8000-000000000000`,
        phase: 'cleaning', marker: null, emptyTarget: false, removal: `${source}.moved-00000000-0000-4000-8000-000000000001`,
      }));
      if (locked) {
        await chmod(path.dirname(source), 0o555);
        restore.push(() => chmod(path.dirname(source), 0o755));
      }
      const workspace = await open(context);
      expect(workspace.status().vaultPath).toBe(target);
      if (!locked) {
        expect(existsSync(source)).toBe(false);
        expect(await leftovers(path.dirname(source))).toEqual([]);
        expect(existsSync(path.join(context.profile, MOVE_JOURNAL))).toBe(false);
      } else {
        expect(existsSync(path.join(source, VAULT_MARKER))).toBe(true);
        const events = (await stores.at(-1)!.activity.query({}, { vaultPath: null })).events;
        expect(events.find((event) => event.eventType === 'vault.move_cleanup_failed')?.message).toContain(source);
      }
    }
  });

  it('leaves an unfinished move alone when the location was fixed at startup', async () => {
    const context = await setup();
    await mkdir(context.profile, { recursive: true });
    const journal = JSON.stringify({
      version: 1, vaultId: await readVaultId(context.source), source: context.source, target: path.join(context.root, 'Moved'),
      staging: `${path.join(context.root, 'Moved')}.moving-00000000-0000-4000-8000-000000000000`, phase: 'switched', marker: null, emptyTarget: false, removal: null,
    });
    await writeFile(path.join(context.profile, MOVE_JOURNAL), journal);
    const workspace = await open(context, { fixedLocation: true });
    expect(await readFile(path.join(context.profile, MOVE_JOURNAL), 'utf8')).toBe(journal);
    expect(existsSync(path.join(context.source, VAULT_MARKER))).toBe(true);
    const events = (await stores[0]!.activity.query({}, workspace.activityScope())).events;
    expect(events.find((event) => event.eventType === 'vault.move_pending')).toMatchObject({ severity: 'warning' });
  });
});

describe('Vault identity (A-08)', () => {
  it('continues jobs only in the Vault that accepted them', async () => {
    const context = await setup();
    const { root, source } = context;
    // Vault A stops with a queued job.
    const gated = gatedCapture(new Set([IDS[0]!]));
    const jobStore = await JobStore.open(context.jobsDir);
    stores.push(jobStore);
    const a = await open(context, { jobStore, capture: gated.capture }, false);
    await a.jobs.submitItem('youtube', urlOf(IDS[0]!));
    const left = await a.jobs.submitItem('youtube', urlOf(IDS[1]!));
    await expect.poll(() => gated.started.length).toBe(1);
    gated.open();
    await a.close();
    expect(jobStore.get(left.job.id)).toMatchObject({ state: 'interrupted', vaultId: await readVaultId(source) });
    expect([...(await packageFiles(await packageBytes(source))).keys()]).not.toContain(VAULT_MARKER);
    // A copy of A elsewhere carries the same ID but is not where the job was accepted.
    const copy = path.join(root, 'Copy');
    await cp(source, copy, { recursive: true });
    const copied = await open({ ...context, source: copy, selection: new VaultSelection(path.join(root, 'copy-selection.json')) }, { jobStore }, false);
    expect(copied.jobs.list({ state: 'all' }).jobs).toEqual([]);
    await copied.close();
    expect(jobStore.get(left.job.id)!.state).toBe('interrupted');
    // A Vault imported from A's export at A's path after A is gone does not take the job either.
    const exported = path.join(root, 'A.zip');
    await writeFile(exported, await packageBytes(source));
    await rm(source, { recursive: true });
    await importNewVault({ packageFile: exported, folder: source, profilePath: path.join(root, 'b-profile'), createdBy: 'XR Collector test' });
    const b = await open({ ...context, selection: new VaultSelection(path.join(root, 'b-selection.json')) }, { jobStore }, false);
    expect(b.status().vaultPath).toBe(source);
    expect(b.jobs.list({ state: 'all' }).jobs).toEqual([]);
    expect(jobStore.get(left.job.id)!.state).toBe('interrupted');
    await b.close();
    // Back in A (here: its copy put back at its path), the job continues.
    await rm(source, { recursive: true });
    await cp(copy, source, { recursive: true });
    await context.selection.write(source);
    const back = await open(context, { jobStore });
    expect((await back.jobs.whenSettled(left.job.id)).state).toBe('completed');
  });

  it('refuses a Vault whose marker has no ID and leaves the marker as it was', async () => {
    const context = await setup();
    const marker = JSON.parse(await readFile(path.join(context.source, VAULT_MARKER), 'utf8')) as Record<string, unknown>;
    delete marker.id;
    const text = JSON.stringify(marker);
    await writeFile(path.join(context.source, VAULT_MARKER), text);
    expect(await inspectVaultDirectory(context.source)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('識別碼') });
    await expect(open(context)).rejects.toMatchObject({ code: 'vault_invalid', message: expect.stringContaining('識別碼') });
    expect(await readFile(path.join(context.source, VAULT_MARKER), 'utf8')).toBe(text);
  });

  it('never gives jobs recorded at a path to a Vault moved there, whether the move fails or succeeds', async () => {
    const context = await setup();
    const target = path.join(context.root, 'Moved');
    await mkdir(context.jobsDir, { recursive: true });
    const at = '2026-10-01T00:00:00.000Z';
    await writeFile(path.join(context.jobsDir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{
      id: 'legacy-at-target', kind: 'youtube.video', state: 'interrupted', phase: null, vaultPath: target, parentId: null,
      source: { type: 'youtube', id: IDS[3], url: urlOf(IDS[3]!), title: null }, createdAt: at, startedAt: null, finishedAt: at, updatedAt: at,
      progress: null, items: null, result: null, error: { code: 'interrupted', message: 'stopped' },
      recovery: { resumedCount: 0, uncleanStops: 0, lastInterruptedAt: at, lastResumedAt: null, lastStop: 'shutdown' },
    }] }));
    let fail = true;
    const workspace = await open(context, { moveFaults: (phase) => { if (fail && phase === 'prepared') throw new Error('index'); } });
    await workspace.move(target);
    await settled(workspace);
    expect(workspace.status().state).toBe('error');
    expect(stores[0]!.get('legacy-at-target')!.vaultId).toBeUndefined();
    fail = false;
    await workspace.move(target);
    await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: target });
    expect(stores[0]!.get('legacy-at-target')).toMatchObject({ state: 'interrupted' });
    expect(stores[0]!.get('legacy-at-target')!.vaultId).toBeUndefined();
    expect(() => workspace.jobs.get('legacy-at-target')).toThrow();
  });

  it('keeps a bounded list of locations per Vault', async () => {
    const profile = await temp();
    for (let index = 0; index < 25; index += 1) await recordPreviousLocation(profile, 'vault-a', `/place/${index}`, `/place/${index + 1}`);
    await recordPreviousLocation(profile, 'vault-b', '/other/1', '/other/2');
    const paths = await previousLocations(profile, 'vault-a');
    expect(paths).toHaveLength(20);
    expect(paths[0]).toBe('/place/24');
    expect(await previousLocations(profile, 'vault-b')).toEqual(['/other/1']);
  });
});

describe('opening another Vault (A-13)', () => {
  it('pauses the active Vault\'s work, continues the other Vault\'s, and never mixes them', async () => {
    const context = await setup('A');
    const { root, source: a } = context;
    const b = path.join(root, 'B');
    await seed(b);
    const jobStore = await JobStore.open(context.jobsDir);
    stores.push(jobStore);
    // B stops with a queued job.
    const bGate = gatedCapture(new Set([IDS[2]!]));
    const bFirst = await open({ ...context, source: b, selection: new VaultSelection(path.join(root, 'b-selection.json')) }, { jobStore, capture: bGate.capture }, false);
    await bFirst.jobs.submitItem('youtube', urlOf(IDS[2]!));
    const bLeft = await bFirst.jobs.submitItem('youtube', urlOf(IDS[3]!));
    await expect.poll(() => bGate.started.length).toBe(1);
    bGate.open();
    await bFirst.close();
    // A has a queued job when B is opened.
    const aGate = gatedCapture(new Set([IDS[0]!]));
    const workspace = await open(context, { jobStore, capture: aGate.capture });
    const aRunning = await workspace.jobs.submitItem('youtube', urlOf(IDS[0]!));
    const aLeft = await workspace.jobs.submitItem('youtube', urlOf(IDS[1]!));
    await expect.poll(() => aGate.started.length).toBe(1);
    for (const [value, code] of [[a, 'invalid_request'], [path.join(a, 'attachments'), 'invalid_request'], [path.join(root, 'Nothing'), 'vault_invalid'], [path.join(root, 'profile'), 'invalid_request']] as const) {
      await expect(workspace.openOther(value), value).rejects.toMatchObject({ code });
    }
    expect(workspace.status().state).toBe('idle');
    await workspace.openOther(b);
    aGate.open();
    await settled(workspace);
    expect(workspace.status()).toMatchObject({
      state: 'completed', operation: 'open', vaultPath: b, result: { previousVaultPath: a, interruptedJobs: 1, resumedJobs: 1 },
    });
    expect(jobStore.get(aRunning.job.id)!.state).toBe('completed');
    expect((await workspace.jobs.whenSettled(bLeft.job.id)).state).toBe('completed');
    expect(jobStore.get(aLeft.job.id)).toMatchObject({ state: 'interrupted', vaultPath: a });
    expect(await new MarkdownVault(b).read(`youtube:${IDS[1]}`)).toBeNull();
    expect(await context.selection.read()).toBe(b);
    // A copy of A does not continue A's job; A itself does.
    const copy = path.join(root, 'A copy');
    await cp(a, copy, { recursive: true });
    await workspace.openOther(copy);
    await settled(workspace);
    expect(workspace.status()).toMatchObject({ vaultPath: copy, result: { resumedJobs: 0 } });
    await workspace.openOther(a);
    await settled(workspace);
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: a, result: { resumedJobs: 1 } });
    expect((await workspace.jobs.whenSettled(aLeft.job.id)).state).toBe('completed');
    expect(await new MarkdownVault(a).read(`youtube:${IDS[1]}`)).not.toBeNull();
    expect(await new MarkdownVault(copy).read(`youtube:${IDS[1]}`)).toBeNull();
  });

  it('refuses to move or switch a Vault whose location was fixed at startup', async () => {
    const context = await setup();
    const workspace = await open(context, { fixedLocation: true });
    expect(workspace.status().relocationUnavailable).toMatchObject({ code: 'vault_location_fixed' });
    await expect(workspace.move(path.join(context.root, 'Moved'))).rejects.toMatchObject({ code: 'vault_location_fixed' });
    await expect(workspace.checkMove(path.join(context.root, 'Moved'))).rejects.toMatchObject({ code: 'vault_location_fixed' });
    await expect(workspace.openOther(context.root)).rejects.toMatchObject({ code: 'vault_location_fixed' });
  });
});

describe('move and open through HTTP (A-10)', () => {
  it('serves the same checks and results to the UI and an authenticated Agent', async () => {
    const context = await setup();
    const target = path.join(context.root, 'Moved');
    const workspace = await open(context);
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test-token' });
    const agent = { authorization: 'Bearer test-token' };
    try {
      expect((await app.inject({ method: 'POST', url: '/api/vault/move/check', payload: { targetPath: target } })).statusCode).toBe(401);
      const check = await app.inject({ method: 'POST', url: '/api/vault/move/check', headers: agent, payload: { targetPath: target } });
      expect(check.statusCode).toBe(200);
      expect(check.json()).toMatchObject({ targetPath: target, requiredBytes: expect.any(Number), availableBytes: expect.any(Number) });
      const refused = await app.inject({ method: 'POST', url: '/api/vault/move', headers: agent, payload: { targetPath: context.source } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('目前的知識庫') });
      const moved = await app.inject({ method: 'POST', url: '/api/vault/move', headers: agent, payload: { targetPath: target } });
      expect(moved.statusCode).toBe(202);
      expect(moved.json()).toMatchObject({ operation: 'move' });
      const busy = await app.inject({ method: 'POST', url: '/api/vault/open', headers: agent, payload: { path: context.source } });
      expect([400, 409]).toContain(busy.statusCode);
      await settled(workspace);
      const status = await app.inject({ url: '/api/vault/status', headers: agent });
      expect(status.json()).toMatchObject({ state: 'completed', vaultPath: target, relocationUnavailable: null });
      const missing = await app.inject({ method: 'POST', url: '/api/vault/open', headers: agent, payload: { path: path.join(context.root, 'Nothing') } });
      expect(missing.statusCode).toBe(422);
    } finally { await app.close(); }
  });

  it('answers 409 vault_location_fixed for a fixed location and 507 when space is short', async () => {
    const context = await setup();
    const fixed = await open(context, { fixedLocation: true });
    const app = await createHttpApp({ transfer: fixed });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/vault/move', payload: { targetPath: path.join(context.root, 'Moved') } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('vault_location_fixed');
      expect((await app.inject('/api/vault/status')).json().relocationUnavailable.code).toBe('vault_location_fixed');
    } finally { await app.close(); }
    await fixed.close(); workspaces.splice(workspaces.indexOf(fixed), 1);
    const tiny = await open(context, { statfs: async () => ({ bavail: 1, bsize: 1 }), jobStore: stores[0]! });
    const second = await createHttpApp({ transfer: tiny });
    try {
      const response = await second.inject({ method: 'POST', url: '/api/vault/move', payload: { targetPath: path.join(context.root, 'Moved') } });
      expect(response.statusCode).toBe(507);
      expect(response.json().error.code).toBe('insufficient_space');
    } finally { await second.close(); }
  });
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('moves with real Meilisearch and searches at the new location (A-12)', async () => {
  const context = await setup();
  const target = path.join(context.root, 'Moved');
  const searchData = path.join(context.profile, 'search');
  const workspace = await open(context, { createSearch: undefined, searchBinary: path.resolve('resources/bin/mac/meilisearch'), searchData });
  await expect.poll(() => workspace.search.status().state, { timeout: 10_000 }).toBe('ready');
  const before = (await readdir(context.profile)).filter((name) => name.startsWith('search-'));
  expect(before).toHaveLength(2);
  await workspace.move(target);
  await expect.poll(() => workspace.status().state, { timeout: 30_000 }).toMatch(/^(completed|error)$/u);
  expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: target });
  expect((await workspace.search.search({ query: '森林觀測' })).hits[0]?.id).toBe('youtube:seed0000001');
  const after = (await readdir(context.profile)).filter((name) => name.startsWith('search-'));
  expect(after).toHaveLength(2);
  expect(after).not.toEqual(before);
}, 60_000);

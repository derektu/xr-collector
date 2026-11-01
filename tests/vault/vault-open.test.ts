import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedDocument, TranscriptSearch } from '../../src/core/types.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { createVaultDirectory, inspectVaultDirectory, readVaultId, VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { packageBytes, packageFiles } from './package-fixtures.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { importNewVault } from '../../src/vault/vault-import.js';
import { VaultWorkspace, type WorkspaceOptions } from '../../src/vault/workspace.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { withYouTube, type YouTubeTestSources } from '../support/youtube-sources.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';

const roots: string[] = [];
const workspaces: VaultWorkspace[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-open-'));
  roots.push(root);
  return root;
}

const video = (id: string): CapturedTranscript => ({
  videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}`, title: `開啟測試 ${id}`, channelId: 'UC123', channelTitle: '測試頻道',
  publishedAt: null, languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual', bodyMarkdown: `森林觀測 ${id}`,
});
const urlOf = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const IDS = ['open0000001', 'open0000002', 'open0000003', 'open0000004'];

async function seed(root: string): Promise<void> {
  await createVaultDirectory(root, 'XR Collector test');
  await new MarkdownVault(root).add(transcriptDocument(video('seed0000001')));
  await new JsonSubscriptionStore(root, 'youtube').add({
    id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
    settings: { intervalMinutes: 60, backfillDays: 30, backfillMaxItems: 10 }, nextCheckAt: '2099-01-01T00:00:00.000Z', lastDispatchedAt: null,
  });
  await mkdir(path.join(root, 'attachments'), { recursive: true });
  await writeFile(path.join(root, 'attachments/sample.bin'), Buffer.from([0, 1, 128, 255]));
  await mkdir(path.join(root, '.obsidian'), { recursive: true });
  await writeFile(path.join(root, '.obsidian/workspace.json'), '{"使用者":"自訂設定"}');
  await mkdir(path.join(root, 'empty folder'));
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
    await workspace.operationFinished();
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
    await workspace.operationFinished();
    expect(workspace.status()).toMatchObject({ vaultPath: copy, result: { resumedJobs: 0 } });
    await workspace.openOther(a);
    await workspace.operationFinished();
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: a, result: { resumedJobs: 1 } });
    expect((await workspace.jobs.whenSettled(aLeft.job.id)).state).toBe('completed');
    expect(await new MarkdownVault(a).read(`youtube:${IDS[1]}`)).not.toBeNull();
    expect(await new MarkdownVault(copy).read(`youtube:${IDS[1]}`)).toBeNull();
  });

  it('refuses to open another Vault when the location was fixed at startup', async () => {
    const context = await setup();
    const workspace = await open(context, { fixedLocation: true });
    expect(workspace.status().relocationUnavailable).toMatchObject({ code: 'vault_location_fixed' });
    await expect(workspace.openOther(context.root)).rejects.toMatchObject({ code: 'vault_location_fixed' });
  });
});

describe('creating a new Vault while one is active', () => {
  it('creates the named folder, switches to it and leaves the previous Vault as it was', async () => {
    const context = await setup();
    const workspace = await open(context);
    const before = await readFile(path.join(context.source, VAULT_MARKER), 'utf8');
    for (const [location, name, code] of [
      [context.root, 'Vault', 'vault_invalid'], [context.source, 'Inside', 'vault_invalid'], [context.profile, 'Profile', 'vault_invalid'],
      [context.root, 'a:b', 'vault_invalid'], [path.join(context.root, 'missing'), 'New', 'vault_invalid'],
    ] as const) {
      await expect(workspace.createNew(location, name), `${location} ${name}`).rejects.toMatchObject({ code });
    }
    expect(workspace.status()).toMatchObject({ state: 'idle', vaultPath: context.source });

    await workspace.createNew(context.root, 'Second');
    await workspace.operationFinished();
    const created = path.join(context.root, 'Second');
    expect(workspace.status()).toMatchObject({
      state: 'completed', operation: 'create', vaultPath: created, result: { previousVaultPath: context.source, interruptedJobs: 0 },
    });
    expect(await inspectVaultDirectory(created)).toEqual({ kind: 'existing', path: created, documentCount: 0 });
    expect(await readVaultId(created)).not.toBe(await readVaultId(context.source));
    expect(await context.selection.read()).toBe(created);
    expect(await readFile(path.join(context.source, VAULT_MARKER), 'utf8')).toBe(before);
    expect(await new MarkdownVault(context.source).read('youtube:seed0000001')).not.toBeNull();

    await workspace.openOther(context.source);
    await workspace.operationFinished();
    expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: context.source });
  });

  it('removes the new folder and keeps the active Vault when the switch fails', async () => {
    const context = await setup();
    const workspace = await open(context, {
      createSearch: async (destination) => ({ search: fakeSearch(destination, destination !== context.source), close: async () => undefined }),
    });
    await workspace.createNew(context.root, 'Broken');
    await workspace.operationFinished();
    expect(workspace.status()).toMatchObject({ state: 'error', operation: 'create', vaultPath: context.source });
    await expect(readFile(path.join(context.root, 'Broken', VAULT_MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await context.selection.read()).toBeNull();
  });

  it('refuses when the location was fixed at startup', async () => {
    const context = await setup();
    const workspace = await open(context, { fixedLocation: true });
    await expect(workspace.createNew(context.root, 'Other')).rejects.toMatchObject({ code: 'vault_location_fixed' });
    await expect(readFile(path.join(context.root, 'Other', VAULT_MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('opening another Vault through HTTP (A-10)', () => {
  it('serves the same results to the UI and an authenticated Agent, and has no move routes', async () => {
    const context = await setup('A');
    const b = path.join(context.root, 'B');
    await seed(b);
    const workspace = await open(context);
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test-token' });
    const agent = { authorization: 'Bearer test-token' };
    try {
      expect((await app.inject({ method: 'POST', url: '/api/vault/open', payload: { path: b } })).statusCode).toBe(401);
      for (const url of ['/api/vault/move', '/api/vault/move/check']) {
        expect((await app.inject({ method: 'POST', url, headers: agent, payload: { targetPath: path.join(context.root, 'Moved') } })).statusCode, url).toBe(404);
      }
      const missing = await app.inject({ method: 'POST', url: '/api/vault/open', headers: agent, payload: { path: path.join(context.root, 'Nothing') } });
      expect(missing.statusCode).toBe(422);
      const conflict = await app.inject({ method: 'POST', url: '/api/vault/create', headers: agent, payload: { location: context.root, name: 'B' } });
      expect(conflict.statusCode).toBe(422);
      expect(conflict.json().error.message).toBe('這個位置已經有「B」，請換個名稱。');
      const created = await app.inject({ method: 'POST', url: '/api/vault/create', headers: agent, payload: { location: context.root, name: 'C' } });
      expect(created.statusCode).toBe(202);
      expect(created.json()).toMatchObject({ operation: 'create' });
      await workspace.operationFinished();
      expect((await app.inject({ url: '/api/vault/status', headers: agent })).json()).toMatchObject({ state: 'completed', vaultPath: path.join(context.root, 'C') });
      const opened = await app.inject({ method: 'POST', url: '/api/vault/open', headers: agent, payload: { path: b } });
      expect(opened.statusCode).toBe(202);
      expect(opened.json()).toMatchObject({ operation: 'open' });
      await workspace.operationFinished();
      const status = await app.inject({ url: '/api/vault/status', headers: agent });
      expect(status.json()).toMatchObject({ state: 'completed', vaultPath: b, relocationUnavailable: null });
    } finally { await app.close(); }
  });

  it('answers 409 vault_location_fixed for a fixed location', async () => {
    const context = await setup();
    const fixed = await open(context, { fixedLocation: true });
    const app = await createHttpApp({ transfer: fixed });
    try {
      for (const [url, payload] of [['/api/vault/open', { path: path.join(context.root, 'Other') }], ['/api/vault/create', { location: context.root, name: 'Other' }]] as const) {
        const response = await app.inject({ method: 'POST', url, payload });
        expect(response.statusCode, url).toBe(409);
        expect(response.json().error.code, url).toBe('vault_location_fixed');
      }
      expect((await app.inject('/api/vault/status')).json().relocationUnavailable.code).toBe('vault_location_fixed');
    } finally { await app.close(); }
  });
});

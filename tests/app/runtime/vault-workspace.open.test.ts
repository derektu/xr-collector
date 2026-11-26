// Broken, opening or creating another Vault continues work in the wrong Vault or in a copy, changes the previous Vault,
// or reports a switch finished before its job records are written.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedDocument } from '../../../src/shared/documents/document-types.js';
import type { TranscriptSearch } from '../../../src/shared/api/search-types.js';
import { openJobRecords, type JobRecords } from '../../../src/app/runtime/job-records.js';
import { MarkdownVault } from '../../../src/domain/vault/markdown-vault.js';
import { createVaultDirectory, inspectVaultDirectory, readVaultId, VAULT_MARKER } from '../../../src/domain/vault/vault-directory.js';
import { VaultSelection } from '../../../src/domain/vault/vault-selection.js';
import { VaultWorkspace, type WorkspaceOptions } from '../../../src/app/runtime/vault-workspace.js';
import { JobStore } from '../../../src/domain/jobs/job-store.js';
import { JsonSubscriptionStore } from '../../../src/domain/subscriptions/subscription-store.js';
import type { CapturedTranscript } from '../../../src/domain/sources/youtube/adapter.js';
import { workspaceWithYouTube, type YouTubeTestSources } from '../../support/youtube-sources.js';
import { transcriptDocument } from '../../../src/domain/sources/youtube/server.js';
import { eventually } from '../../support/wait.js';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { recordingLog } from '../../support/log.js';

const roots: string[] = [];
const workspaces: VaultWorkspace[] = [];
const stores: JobRecords[] = [];
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
  await createVaultDirectory(root, 'XR Collector test', PRODUCT_SOURCES);
  await new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES)).add(transcriptDocument(video('seed0000001')));
  await new JsonSubscriptionStore(new VaultFileWriter(root, PRODUCT_SOURCES), 'youtube').add({
    id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
    settings: { intervalMinutes: 60, backfillDays: 30, backfillMaxItems: 10 }, nextCheckAt: '2099-01-01T00:00:00.000Z', lastDispatchedAt: null,
  });
  await mkdir(path.join(root, 'attachments'), { recursive: true });
  await writeFile(path.join(root, 'attachments/sample.bin'), Buffer.from([0, 1, 128, 255]));
  await mkdir(path.join(root, '.obsidian'), { recursive: true });
  await writeFile(path.join(root, '.obsidian/workspace.json'), '{"使用者":"自訂設定"}');
  await mkdir(path.join(root, 'empty folder'));
}

function fakeSearch(root: string): TranscriptSearch {
  let docs: SavedDocument[] = [];
  return {
    status: () => ({ state: 'ready', indexedDocuments: docs.length, lastRebuiltAt: null }),
    async index(doc) { docs.push(doc); },
    async remove(id) { docs = docs.filter((doc) => doc.id !== id); },
    async rebuild() {
      const vault = new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES));
      docs = (await Promise.all((await vault.list()).map(({ id }) => vault.read(id)))).filter((doc): doc is SavedDocument => !!doc);
    },
    async search({ query }) {
      const hits = docs.filter((doc) => doc.bodyMarkdown.includes(query)).map((doc) => ({ ...doc, snippet: doc.bodyMarkdown }));
      return { hits, total: hits.length, statusCounts: { draft: 0, published: 0 }, offset: 0, limit: 50 };
    },
  };
}

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
  return { root, source, profile, selection: new VaultSelection(profile), jobsDir: path.join(profile, 'jobs') };
}

async function open(context: Setup, overrides: Partial<WorkspaceOptions> & YouTubeTestSources = {}, track = true): Promise<VaultWorkspace> {
  const records = overrides.jobStore ? null : await openJobRecords(context.jobsDir, PRODUCT_SOURCES, { log: recordingLog() });
  const jobStore = overrides.jobStore ?? records!.jobs;
  if (track && records) stores.push(records);
  const workspace = await VaultWorkspace.open(workspaceWithYouTube({
    sources: PRODUCT_SOURCES, log: recordingLog(), root: await context.selection.read() ?? context.source, selection: context.selection,
    createdBy: 'XR Collector test', capture: { capture: async (target) => video(target.videoId) },
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: '', searchLexicon: '', searchData: path.join(context.profile, 'search'), exportFolder: path.join(context.root, 'exports'), backupFolder: path.join(context.root, 'backups'),
    createSearch: async (destination) => ({ search: fakeSearch(destination), close: async () => undefined }),
    jobStore, jobLimits: { capture: 1 },
    ...overrides,
  }));
  if (track) workspaces.push(workspace);
  return workspace;
}

describe('opening another Vault (A-13)', () => {
  it('pauses the active Vault\'s work, continues the other Vault\'s, and never continues it in a copy', async () => {
    const context = await setup('A');
    const { root, source: a } = context;
    const b = path.join(root, 'B');
    await seed(b);
    const records = await openJobRecords(context.jobsDir, PRODUCT_SOURCES, { log: recordingLog() });
    const jobStore = records.jobs;
    stores.push(records);
    const bGate = gatedCapture(new Set([IDS[2]!]));
    const bFirst = await open({ ...context, source: b, selection: new VaultSelection(path.join(root, 'b-profile')) }, { jobStore, capture: bGate.capture }, false);
    await bFirst.jobs.submitItem('youtube', urlOf(IDS[2]!));
    const bLeft = await bFirst.jobs.submitItem('youtube', urlOf(IDS[3]!));
    await eventually(() => expect(bGate.started.length).toBe(1));
    bGate.open();
    await bFirst.close();
    const aGate = gatedCapture(new Set([IDS[0]!]));
    const workspace = await open(context, { jobStore, capture: aGate.capture });
    const aRunning = await workspace.jobs.submitItem('youtube', urlOf(IDS[0]!));
    const aLeft = await workspace.jobs.submitItem('youtube', urlOf(IDS[1]!));
    await eventually(() => expect(aGate.started.length).toBe(1));
    await workspace.operations.openOther(b);
    aGate.open();
    await workspace.operations.finished();
    expect(workspace.operations.status()).toMatchObject({
      state: 'completed', operation: 'open', vaultPath: b, result: { previousVaultPath: a, interruptedJobs: 1, resumedJobs: 1 },
    });
    expect(jobStore.get(aRunning.job.id)!.state).toBe('completed');
    expect((await workspace.jobs.whenSettled(bLeft.job.id)).state).toBe('completed');
    expect(jobStore.get(aLeft.job.id)).toMatchObject({ state: 'interrupted', vaultPath: a });
    expect(await new MarkdownVault(new VaultFileWriter(b, PRODUCT_SOURCES)).read(`youtube:${IDS[1]}`)).toBeNull();
    expect(await context.selection.read()).toBe(b);
    const copy = path.join(root, 'A copy');
    await cp(a, copy, { recursive: true });
    await workspace.operations.openOther(copy);
    await workspace.operations.finished();
    expect(workspace.operations.status()).toMatchObject({ vaultPath: copy, result: { resumedJobs: 0 } });
    await workspace.operations.openOther(a);
    await workspace.operations.finished();
    expect(workspace.operations.status()).toMatchObject({ state: 'completed', vaultPath: a, result: { resumedJobs: 1 } });
    expect((await workspace.jobs.whenSettled(aLeft.job.id)).state).toBe('completed');
    expect(await new MarkdownVault(new VaultFileWriter(copy, PRODUCT_SOURCES)).read(`youtube:${IDS[1]}`)).toBeNull();
  });
});

it('reports the switch unfinished while the job records it changed cannot be written, and finished once they can', async () => {
  const context = await setup('A');
  const b = path.join(context.root, 'B');
  await seed(b);
  const jobStore = await JobStore.open(context.jobsDir, PRODUCT_SOURCES, { event: () => undefined }, recordingLog());
  const gate = gatedCapture(new Set([IDS[0]!]));
  const workspace = await open(context, { jobStore, capture: gate.capture });
  await workspace.jobs.submitItem('youtube', urlOf(IDS[0]!));
  await workspace.jobs.submitItem('youtube', urlOf(IDS[1]!));
  await eventually(() => expect(gate.started.length).toBe(1));
  await jobStore.flush();
  await rm(context.jobsDir, { recursive: true });
  await writeFile(context.jobsDir, '');
  await workspace.operations.openOther(b);
  gate.open();
  await expect(workspace.operations.finished()).rejects.toMatchObject({ code: 'jobs_write_failed' });

  await rm(context.jobsDir);
  await mkdir(context.jobsDir);
  await workspace.operations.finished();
  expect(workspace.operations.status()).toMatchObject({ state: 'completed', operation: 'open', vaultPath: b });
});

it('creates a new Vault while one is active, switches to it and leaves the previous Vault as it was', async () => {
  const context = await setup();
  const workspace = await open(context);
  const before = await readFile(path.join(context.source, VAULT_MARKER), 'utf8');
  await workspace.operations.createNew(context.root, 'Second');
  await workspace.operations.finished();
  const created = path.join(context.root, 'Second');
  expect(workspace.operations.status()).toMatchObject({
    state: 'completed', operation: 'create', vaultPath: created, result: { previousVaultPath: context.source, interruptedJobs: 0 },
  });
  expect(await inspectVaultDirectory(created, PRODUCT_SOURCES)).toEqual({ kind: 'existing', path: created, documentCount: 0 });
  expect(await readVaultId(created)).not.toBe(await readVaultId(context.source));
  expect(await context.selection.read()).toBe(created);
  expect(await readFile(path.join(context.source, VAULT_MARKER), 'utf8')).toBe(before);
  expect(await new MarkdownVault(new VaultFileWriter(context.source, PRODUCT_SOURCES)).read('youtube:seed0000001')).not.toBeNull();
});

it('refuses to open or create another Vault when the location was fixed at startup', async () => {
  const context = await setup();
  const workspace = await open(context, { fixedLocation: true });
  expect(workspace.operations.status().relocationUnavailable).toMatchObject({ code: 'vault_location_fixed' });
  await expect(workspace.operations.openOther(context.root)).rejects.toMatchObject({ code: 'vault_location_fixed' });
  await expect(workspace.operations.createNew(context.root, 'Other')).rejects.toMatchObject({ code: 'vault_location_fixed' });
  await expect(readFile(path.join(context.root, 'Other', VAULT_MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
});

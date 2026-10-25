import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonScheduleStore } from '../../src/subscriptions/schedule-store.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import type { ImportMode, SavedDocument, TranscriptSearch, SubscriptionRecord } from '../../src/core/types.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { VaultWorkspace, type WorkspaceOptions } from '../../src/vault/workspace.js';
import { ensureMarker } from './package-fixtures.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { withYouTube, type YouTubeTestSources } from '../support/youtube-sources.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';

/** Vaults, machines and workspaces for export and import tests, each in its own temporary folder. */

const roots: string[] = [];
const workspaces: VaultWorkspace[] = [];

/** Closes the workspaces and removes the folders a test made; call from `afterEach`. */
export async function cleanUp(): Promise<void> {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function temp(prefix = 'xr-exchange-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export const capture: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: '跨機測試', channelId: 'UC123', channelTitle: '測試頻道', publishedAt: null,
  languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual',
  bodyMarkdown: '獨立森林觀測資料。',
};

export const video = (videoId: string, overrides: Partial<CapturedTranscript> = {}): CapturedTranscript => ({
  ...capture, videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: `影片 ${videoId}`, bodyMarkdown: `${videoId} 的字幕。`, ...overrides,
});

export const settings = { intervalMinutes: 60, backfillDays: 30, backfillMaxItems: 10 };

export function channel(id: string, overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id, title: `頻道 ${id}`, url: `https://www.youtube.com/channel/${id}`, enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
    settings, nextCheckAt: '2099-01-01T00:00:00.000Z', lastDispatchedAt: null, ...overrides,
  };
}

/** A Vault with one document, one subscription and automatic collection on. */
export async function seed(root: string): Promise<void> {
  await new MarkdownVault(root).add(transcriptDocument(capture));
  await new JsonSubscriptionStore(root, 'youtube').add(channel('UC123', { title: '測試頻道' }));
  await new JsonScheduleStore(root).save({ enabled: true });
}

export function fakeSearch(root: string): TranscriptSearch {
  let docs: SavedDocument[] = [];
  return {
    status: () => ({ state: 'ready', indexedDocuments: docs.length }),
    async index(doc) { docs = [...docs.filter((existing) => existing.id !== doc.id), doc]; },
    async remove(id) { docs = docs.filter((doc) => doc.id !== id); },
    async rebuild() {
      const vault = new MarkdownVault(root);
      docs = (await Promise.all((await vault.list()).map(({ id }) => vault.read(id)))).filter((doc): doc is SavedDocument => !!doc);
    },
    async search({ query }) {
      const hits = docs.filter((doc) => doc.bodyMarkdown.includes(query) || doc.title.includes(query)).map((doc) => ({ ...doc, snippet: doc.bodyMarkdown }));
      return { hits, total: hits.length, offset: 0, limit: 50 };
    },
  };
}

/** One machine: its Vault folder, its profile and its export folder. */
export interface Machine { name: string; root: string; vault: string; profile: string; exports: string; backups: string }

export async function machine(name: string, root?: string): Promise<Machine> {
  const base = root ?? await temp();
  const folder = path.join(base, name);
  await mkdir(folder, { recursive: true });
  return { name, root: base, vault: path.join(folder, 'Vault'), profile: path.join(folder, 'profile'), exports: path.join(folder, 'exports'), backups: path.join(folder, 'backups') };
}

/** Opens the Vault the machine's selection names (its own Vault when none), as the runtime does at startup. */
export async function open(at: Machine, overrides: Partial<WorkspaceOptions> & YouTubeTestSources = {}, track = true): Promise<VaultWorkspace> {
  const selection = new VaultSelection(path.join(at.profile, 'vault-selection.json'));
  const selected = await selection.read();
  if (!selected) await ensureMarker(at.vault);
  const workspace = await VaultWorkspace.open(withYouTube({
    root: selected ?? at.vault, selection, profilePath: at.profile, createdBy: 'XR Collector test', machineName: at.name,
    exportFolder: at.exports, backupFolder: at.backups, capture: { capture: async (target) => video(target.videoId) },
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: '', searchData: path.join(at.profile, 'search'),
    createSearch: async (destination) => ({ search: fakeSearch(destination), close: async () => undefined }),
    ...overrides,
  }));
  if (track) workspaces.push(workspace);
  return workspace;
}

/** Writes package bytes to a file and returns its path. */
export async function fileOf(folder: string, name: string, bytes: Buffer): Promise<string> {
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, name);
  await writeFile(file, bytes);
  return file;
}

/** Previews and applies an import, returning the preview and the final status. */
export async function importFile(workspace: VaultWorkspace, file: string, mode: ImportMode = 'merge') {
  const preview = await workspace.previewImport(file);
  workspace.applyImport(preview.id, mode);
  await workspace.operationFinished();
  return { preview, status: workspace.status() };
}

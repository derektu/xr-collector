import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector } from '../../src/core/collector.js';
import type { SavedDocument } from '../../src/core/types.js';
import { createHttpApp } from '../../src/server/app.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { backupFolder, exportFolder, IMPORT_JOURNAL, markerDigest } from '../../src/vault/transfer-files.js';
import { readVaultId, VAULT_MARKER, writeVaultMarker } from '../../src/vault/vault-directory.js';
import { importNewVault, type ImportFault } from '../../src/vault/vault-import.js';
import { itemStates } from '../../src/vault/vault-merge.js';
import { registeredFiles, registeredSource } from '../../src/vault/vault-package.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import type { VaultWorkspace, WorkspaceOptions } from '../../src/vault/workspace.js';
import { channel, cleanUp, fakeSearch, fileOf, importFile, machine, open, seed, settings, settled, temp, video, type Machine } from './exchange-fixtures.js';
import { manifestOf, packageOf, tampered } from './package-fixtures.js';

afterEach(cleanUp);

/** Video IDs of the documents the two machines exchange; with the seeded document A starts with five. */
const D1 = 'aaaaaaaaaa1'; const D2 = 'aaaaaaaaaa2'; const D3 = 'aaaaaaaaaa3'; const D4 = 'aaaaaaaaaa4'; const D5 = 'aaaaaaaaaa5';
const SEEDED = 'dQw4w9WgXcQ';
const docPath = (root: string, id: string) => path.join(root, `documents/youtube/${id}.md`);
/** A time after every collection a test makes; larger `n` is later. */
const at = (n: number) => `2030-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;

/** The items of a Vault by key: the state and content, or the time of a deletion. Equal items mean equal content. */
async function items(root: string): Promise<Map<string, string>> {
  const states = await itemStates(registeredSource(await registeredFiles(root)));
  return new Map([...states].map(([key, state]) => [key, state.state === 'present' ? `present:${state.digest}` : `deleted:${state.at}`]));
}
const documents = async (root: string) => (await new MarkdownVault(root).list()).map((document) => document.sourceId).sort();
const deletions = async (root: string) => JSON.parse(await readFile(path.join(root, DELETIONS_FILE), 'utf8')).deleted
  .map((record: { sourceId: string }) => record.sourceId).sort() as string[];

async function add(root: string, id: string) {
  await new MarkdownVault(root).add(video(id));
}
/** Changes a document as the app records a change: new text and `updated_at` set to `when`. */
async function modify(root: string, id: string, text: string, when: string) {
  const file = docPath(root, id);
  const [, front, body] = (await readFile(file, 'utf8')).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u)!;
  const metadata = parse(front!) as { collector: Record<string, unknown> };
  metadata.collector.updated_at = when;
  await writeFile(file, `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body!.trim()}\n${text}\n`);
}
async function remove(root: string, id: string, when: string) {
  await new Collector(new MarkdownVault(root, { now: () => new Date(when) })).delete(`youtube:${id}`);
}
const store = (root: string, when?: string) => new JsonChannelStore(root, when ? () => new Date(when) : undefined);
const channels = async (root: string) => store(root).list();
const scheduleOn = async (root: string) => (await new JsonChannelScheduleStore(root).load()).enabled;
const counts = (documents: Partial<Record<'added' | 'updated' | 'removed', number>>, subscriptions: Partial<Record<'added' | 'updated' | 'removed', number>> = {}) => ({
  documents: { added: 0, updated: 0, removed: 0, ...documents }, subscriptions: { added: 0, updated: 0, removed: 0, ...subscriptions },
});

/** Runs `use` on a workspace of the machine and closes it afterwards. */
async function using<T>(at: Machine, use: (workspace: VaultWorkspace) => Promise<T>, overrides: Partial<WorkspaceOptions> = {}): Promise<T> {
  const workspace = await open(at, overrides, false);
  try { return await use(workspace); } finally { await workspace.close(); }
}

/** Exports the machine's Vault to `<exports>/<name>.zip`. */
async function exportFrom(at: Machine, name: string): Promise<string> {
  await mkdir(at.exports, { recursive: true });
  return using(at, async (workspace) => (await workspace.exportTo(path.join(at.exports, `${name}.zip`))).result!.exportPath!);
}

/** Creates a machine's Vault from an export file as Onboarding does, and names it in its selection. */
async function importAsNew(at: Machine, file: string): Promise<string> {
  const target = await importNewVault({ packageFile: file, folder: at.vault, profilePath: at.profile, createdBy: 'XR Collector test' });
  await new VaultSelection(path.join(at.profile, 'vault-selection.json')).write(target);
  return target;
}

/** A copy of a machine's Vault as another machine, to try a second way of importing the same file. */
async function copyOf(from: Machine, name: string): Promise<Machine> {
  const copy = await machine(name, from.root);
  await cp(from.vault, copy.vault, { recursive: true });
  return copy;
}

/**
 * A on 家裡 and B on 公司: A holds five documents, two subscriptions and automatic collection on;
 * it exports, and B is created from that export.
 */
async function pair() {
  const root = await temp();
  const a = await machine('A', root); const b = await machine('B', root);
  await seed(a.vault);
  for (const id of [D1, D2, D3, D4]) await add(a.vault, id);
  await store(a.vault).add(channel('UC456'));
  const first = await exportFrom(a, 'a-1');
  await importAsNew(b, first);
  return { root, a, b, first };
}

/** B's changes: one addition, update and removal each of documents and subscriptions. */
async function changeB(b: Machine) {
  await add(b.vault, D5);
  await modify(b.vault, D1, 'B 補充的段落', at(1));
  await remove(b.vault, D2, at(1));
  await store(b.vault, at(1)).add(channel('UC789'));
  await store(b.vault, at(1)).update('UC123', { settings: { ...settings, intervalMinutes: 360 } });
  await store(b.vault, at(1)).remove('UC456');
}
const changedCounts = counts({ added: 1, updated: 1, removed: 1 }, { added: 1, updated: 1, removed: 1 });

const workFolders = async (root: string) => (await readdir(root)).filter((name) => name.startsWith('.xr-collector-import-'));
const preImports = async (at: Machine) => existsSync(at.backups) ? (await readdir(at.backups)).filter((name) => name.startsWith('匯入前備份')) : [];

describe('a deletion travels back (X77-A01)', () => {
  it('leaves four documents after B deletes one, whether A merges or replaces', async () => {
    const { a, b } = await pair();
    await remove(b.vault, D2, at(1));
    const file = await exportFrom(b, 'b-1');
    const replacing = await copyOf(a, 'A-replace');

    await using(a, async (workspace) => {
      const { preview, status } = await importFile(workspace, file);
      expect(preview).toMatchObject({
        merge: counts({ removed: 1 }), replace: counts({ removed: 1 }), localNewer: 0,
        package: { fileName: 'b-1.zip', exportedAt: expect.any(String), machine: 'B' },
      });
      expect(status).toMatchObject({ state: 'completed', operation: 'import', result: { importMode: 'merge', imported: counts({ removed: 1 }) } });
      expect(status.message).toContain('匯入完成：文件：刪除 1');
      await expect(workspace.collector.read(`youtube:${D2}`)).rejects.toMatchObject({ code: 'document_deleted' });
    });
    expect(await documents(a.vault)).toHaveLength(4);
    expect(await deletions(a.vault)).toEqual([D2]);
    expect(existsSync(docPath(a.vault, D2))).toBe(false);

    await using(replacing, async (workspace) => { await importFile(workspace, file, 'replace'); });
    expect(await documents(replacing.vault)).toHaveLength(4);
    expect(await items(replacing.vault)).toEqual(await items(b.vault));
  });
});

describe('a deletion and an addition meet (X77-A02)', () => {
  it('keeps A\'s new document in a merge and leaves the file\'s four in a replace', async () => {
    const { a, b } = await pair();
    await remove(b.vault, D2, at(1));
    await add(a.vault, D5);
    const file = await exportFrom(b, 'b-1');
    const replacing = await copyOf(a, 'A-replace');

    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ merge: counts({ removed: 1 }), replace: counts({ removed: 2 }), localNewer: 1 });
      workspace.applyImport(preview.id, 'merge'); await settled(workspace);
    });
    expect(await documents(a.vault)).toEqual([D1, D3, D4, D5, SEEDED].sort());

    await using(replacing, async (workspace) => {
      const { status } = await importFile(workspace, file, 'replace');
      expect(status).toMatchObject({ result: { importMode: 'replace', imported: counts({ removed: 2 }) } });
      expect(status.message).toContain('已完全以匯入內容取代');
    });
    expect(await documents(replacing.vault)).toEqual([D1, D3, D4, SEEDED].sort());
    // The records are the file's: a document only A had leaves without a record of its own.
    expect(await deletions(replacing.vault)).toEqual([D2]);
  });
});

describe('the newer state wins (X77-A03, X77-A04, X77-A05)', () => {
  it('takes the newer of two changes of a document, in both directions (A03)', async () => {
    const { a, b } = await pair();
    await modify(a.vault, D1, 'A 的段落', at(1)); await modify(b.vault, D1, 'B 的段落', at(2));
    await modify(a.vault, D3, 'A 較新的段落', at(3)); await modify(b.vault, D3, 'B 較舊的段落', at(2));
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const { preview } = await importFile(workspace, file);
      expect(preview).toMatchObject({ merge: counts({ updated: 1 }), replace: counts({ updated: 2 }), localNewer: 1 });
      expect((await workspace.search.search({ query: 'B 的段落' })).hits.map((hit) => hit.id)).toEqual([`youtube:${D1}`]);
    });
    expect(await readFile(docPath(a.vault, D1), 'utf8')).toContain('B 的段落');
    expect(await readFile(docPath(a.vault, D3), 'utf8')).toContain('A 較新的段落');

    // Back on B, A's newer change of D3 comes over and D1 is already the same.
    const back = await exportFrom(a, 'a-2');
    await using(b, async (workspace) => {
      expect((await importFile(workspace, back)).preview).toMatchObject({ merge: counts({ updated: 1 }), localNewer: 0 });
    });
    expect(await items(b.vault)).toEqual(await items(a.vault));
  });

  it('lets the newer of a deletion and a change win, in both directions (A04)', async () => {
    const { a, b } = await pair();
    await modify(a.vault, D1, 'A 在刪除之後修改', at(2)); await remove(b.vault, D1, at(1));
    await modify(a.vault, D3, 'A 在刪除之前修改', at(1)); await remove(b.vault, D3, at(2));
    await remove(a.vault, D4, at(1)); await modify(b.vault, D4, 'B 在刪除之後修改', at(2));
    await remove(a.vault, D2, at(2)); await modify(b.vault, D2, 'B 在刪除之前修改', at(1));
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const { preview } = await importFile(workspace, file);
      expect(preview).toMatchObject({ merge: counts({ added: 1, removed: 1 }), localNewer: 2 });
      expect((await workspace.collector.read(`youtube:${D4}`)).bodyMarkdown).toContain('B 在刪除之後修改');
    });
    expect(await readFile(docPath(a.vault, D1), 'utf8')).toContain('A 在刪除之後修改');
    expect(existsSync(docPath(a.vault, D3))).toBe(false);
    expect(await readFile(docPath(a.vault, D4), 'utf8')).toContain('B 在刪除之後修改');
    expect(await deletions(a.vault)).toEqual([D2, D3]);
  });

  it('keeps the newer of two deletion records of a document, without counting it (A04)', async () => {
    const { a, b } = await pair();
    await remove(a.vault, D1, at(1)); await remove(b.vault, D1, at(2));
    await remove(a.vault, D3, at(2)); await remove(b.vault, D3, at(1));
    const deletedAt = async (root: string) => Object.fromEntries(JSON.parse(await readFile(path.join(root, DELETIONS_FILE), 'utf8')).deleted
      .map((record: { sourceId: string; deletedAt: string }) => [record.sourceId, record.deletedAt]));
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ merge: counts({}), localNewer: 0, mergeRecords: true });
      workspace.applyImport(preview.id, 'merge'); await settled(workspace);
      expect(workspace.status().state).toBe('completed');
    });
    expect(await deletedAt(a.vault)).toEqual({ [D1]: at(2), [D3]: at(2) });
  });

  it('keeps the local state when both sides changed at the same time (A05)', async () => {
    const { a, b } = await pair();
    await modify(a.vault, D1, 'A 的段落', at(1)); await modify(b.vault, D1, 'B 的段落', at(1));
    await modify(a.vault, D3, 'A 的段落', at(1)); await remove(b.vault, D3, at(1));
    await store(a.vault, at(1)).update('UC123', { title: 'A 的名稱' }); await store(b.vault, at(1)).update('UC123', { title: 'B 的名稱' });
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ merge: counts({}), replace: counts({ updated: 1, removed: 1 }, { updated: 1 }), localNewer: 3 });
      expect(() => workspace.applyImport(preview.id, 'merge')).toThrow(expect.objectContaining({ message: '沒有需要匯入的內容。' }));
    });
  });
});

describe('the same video on both machines (X77-A06)', () => {
  it('is no change when only the collection time differs', async () => {
    const { a, b } = await pair();
    await new MarkdownVault(a.vault, { now: () => new Date('2026-10-01T00:00:00.000Z') }).add(video('samevideo01'));
    await new MarkdownVault(b.vault, { now: () => new Date('2026-10-05T00:00:00.000Z') }).add(video('samevideo01'));
    expect(await readFile(docPath(a.vault, 'samevideo01'))).not.toEqual(await readFile(docPath(b.vault, 'samevideo01')));
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ merge: counts({}), replace: counts({}), localNewer: 0 });
      expect(() => workspace.applyImport(preview.id, 'replace')).toThrow(expect.objectContaining({ message: '本機內容已與匯入檔相同。' }));
    });
  });
});

describe('Vaults that never exchanged (X77-A07)', () => {
  it('joins both, decides shared items by time and removes nothing without a record', async () => {
    const root = await temp();
    const a = await machine('A', root); const c = await machine('C', root);
    await seed(a.vault); await add(a.vault, D1); await add(a.vault, 'aaaaaaaaaaA');
    await seed(c.vault); await add(c.vault, 'aaaaaaaaaaC');
    await store(c.vault, at(1)).update('UC123', { settings: { ...settings, intervalMinutes: 30 } });
    const file = await exportFrom(c, 'c-1');
    await using(a, async (workspace) => {
      const { preview } = await importFile(workspace, file);
      expect(preview).toMatchObject({ merge: counts({ added: 1 }, { updated: 1 }), localNewer: 2 });
    });
    expect(await documents(a.vault)).toEqual([D1, 'aaaaaaaaaaA', 'aaaaaaaaaaC', SEEDED].sort());
    expect((await channels(a.vault))[0]!.settings.intervalMinutes).toBe(30);
  });
});

describe('subscriptions (X77-A08)', () => {
  it('adds, updates and removes subscriptions by time, keeping local progress and the collection switch', async () => {
    const { a, b } = await pair();
    await changeB(b);
    // A checks its subscription after the export: progress is no change of content.
    await store(a.vault).update('UC123', { lastCheckedAt: '2026-10-18T00:00:00.000Z' });
    await store(a.vault, at(1)).add(channel('UCAAA', { addedAt: at(1) }));
    // B pauses automatic collection; the switch belongs to each Vault and never travels with an import.
    await new JsonChannelScheduleStore(b.vault).save({ enabled: false });
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const { preview } = await importFile(workspace, file);
      expect(preview).toMatchObject({ merge: changedCounts, localNewer: 1 });
    });
    const rows = await channels(a.vault);
    expect(rows.map((row) => row.id).sort()).toEqual(['UC123', 'UC789', 'UCAAA']);
    expect(rows.find((row) => row.id === 'UC123')).toMatchObject({
      settings: { intervalMinutes: 360 }, lastCheckedAt: '2026-10-18T00:00:00.000Z', nextCheckAt: null,
    });
    expect((await store(a.vault).removals()).map((record) => [record.id, record.removedAt])).toEqual([['UC456', at(1)]]);
    expect(await scheduleOn(a.vault)).toBe(true);

    // A subscribes UC456 again after B removed it; the new subscription is newer than the removal.
    await store(a.vault).add(channel('UC456', { addedAt: at(2) }));
    expect(await store(a.vault).removals()).toEqual([]);
    const back = await exportFrom(a, 'a-2');
    await using(b, async (workspace) => {
      expect((await importFile(workspace, back)).preview).toMatchObject({ merge: counts({}, { added: 2 }) });
    });
    expect((await channels(b.vault)).map((row) => row.id).sort()).toEqual(['UC123', 'UC456', 'UC789', 'UCAAA']);
    expect(await store(b.vault).removals()).toEqual([]);
    expect(await scheduleOn(b.vault)).toBe(false);
  });

  it('keeps the local progress and collection switch when replacing', async () => {
    const { a, b } = await pair();
    await changeB(b);
    await store(a.vault).update('UC123', { lastCheckedAt: '2026-10-18T00:00:00.000Z' });
    await new JsonChannelScheduleStore(b.vault).save({ enabled: false });
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => { await importFile(workspace, file, 'replace'); });
    expect(await items(a.vault)).toEqual(await items(b.vault));
    expect((await channels(a.vault)).find((row) => row.id === 'UC123')!.lastCheckedAt).toBe('2026-10-18T00:00:00.000Z');
    expect(await scheduleOn(a.vault)).toBe(true);
  });
});

describe('deletion records of documents the Vault never had (X77-A09)', () => {
  it('come along with a merge without being counted, so collection passes over the video', async () => {
    const { a, b } = await pair();
    await add(b.vault, 'bbbbbbbbbbX'); await remove(b.vault, 'bbbbbbbbbbX', at(1));
    await remove(b.vault, D2, at(1));
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      expect((await importFile(workspace, file)).preview).toMatchObject({ merge: counts({ removed: 1 }), localNewer: 0 });
    });
    expect(await deletions(a.vault)).toEqual([D2, 'bbbbbbbbbbX']);
    expect(await new Collector(new MarkdownVault(a.vault)).isKnown('bbbbbbbbbbX')).toBe(true);
  });

  it('are written by a merge even when they are all the file brings', async () => {
    const { a, b } = await pair();
    await add(b.vault, 'bbbbbbbbbbX'); await remove(b.vault, 'bbbbbbbbbbX', at(1));
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ merge: counts({}), localNewer: 0, mergeRecords: true });
      workspace.applyImport(preview.id, 'merge'); await settled(workspace);
      expect(workspace.status().state).toBe('completed');
    });
    expect(await deletions(a.vault)).toEqual(['bbbbbbbbbbX']);
    expect(await new Collector(new MarkdownVault(a.vault)).isKnown('bbbbbbbbbbX')).toBe(true);
    expect(await items(a.vault)).toEqual(await items(b.vault));
    await using(a, async (workspace) => {
      expect(await workspace.previewImport(file)).toMatchObject({ merge: counts({}), mergeRecords: false });
    });
  });
});

describe('nothing to import (X77-A10)', () => {
  it('counts the newer local changes, refuses a merge and lets a replace go back to the file', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => { await importFile(workspace, file); });
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ merge: counts({}), replace: counts({}), localNewer: 0, mergeRecords: false });
      expect(() => workspace.applyImport(preview.id, 'merge')).toThrow(expect.objectContaining({ message: '沒有需要匯入的內容。' }));
      expect(() => workspace.applyImport(preview.id, 'replace')).toThrow(expect.objectContaining({ message: '本機內容已與匯入檔相同。' }));
      workspace.cancelImport(preview.id);
      expect(workspace.status()).toMatchObject({ state: 'idle', message: '已取消匯入，資料未變更。' });
    });
    expect(await preImports(a)).toHaveLength(1);

    await add(a.vault, 'aaaaaaaaaaA'); await modify(a.vault, D3, 'A 之後的段落', at(5));
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ merge: counts({}), replace: counts({ updated: 1, removed: 1 }), localNewer: 2 });
      workspace.applyImport(preview.id, 'replace'); await settled(workspace);
      expect(workspace.status().state).toBe('completed');
    });
    expect(await items(a.vault)).toEqual(await items(b.vault));
  });
});

describe('the export before an import (X77-A11)', () => {
  it('is written, in a folder it creates, before any file of the Vault changes', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    await rm(a.backups, { recursive: true, force: true });
    const before = await items(a.vault);
    let seen: string[] = [];
    await using(a, async (workspace) => { await importFile(workspace, file); }, {
      importFaults: async (phase) => {
        if (phase !== 'staged') return;
        seen = await preImports(a);
        expect(await items(a.vault)).toEqual(before);
      },
    });
    expect(seen).toHaveLength(1);
    expect(path.basename(seen[0]!)).toMatch(/^匯入前備份 \d{4}-\d{2}-\d{2} \d{6}\.zip$/u);
    expect((await readdir(a.exports)).filter((name) => name.includes('匯入前'))).toEqual([]);
    const manifest = await manifestOf(await readFile(path.join(a.backups, seen[0]!)));
    expect(manifest.summary).toMatchObject({ documents: 5, subscriptions: 2 });
  });

  it('stops the import with the Vault unchanged when the export cannot be written', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    const blocked = path.join(a.root, 'blocked');
    await writeFile(blocked, 'a file where the backup folder should be');
    const before = await items(a.vault);
    await using(a, async (workspace) => {
      await importFile(workspace, file);
      expect(workspace.status()).toMatchObject({ state: 'error', operation: 'import' });
      expect(() => workspace.enterWrite()()).not.toThrow();
    }, { backupFolder: path.join(blocked, 'backups') });
    expect(await items(a.vault)).toEqual(before);
    expect(await workFolders(a.vault)).toEqual([]);
  });

  it('undoes an import: merging it finds nothing, replacing with it restores the Vault as it was', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const original = await items(a.vault);
    const file = await exportFrom(b, 'b-1');
    const backup = await using(a, async (workspace) => (await importFile(workspace, file)).status.result!.backupPath!);
    expect((await manifestOf(await readFile(backup))).source).toMatchObject({ machine: 'A', vaultId: await readVaultId(a.vault) });
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(backup);
      expect(preview).toMatchObject({ merge: counts({}), replace: changedCounts, localNewer: 6 });
      workspace.applyImport(preview.id, 'replace'); await settled(workspace);
      expect(workspace.status().state).toBe('completed');
    });
    expect(await items(a.vault)).toEqual(original);
  });
});

describe('an import stopped while it applies (X77-A12)', () => {
  /** A's content before and after importing B's changes, and B's export. */
  async function prepared() {
    const shared = await pair();
    await changeB(shared.b);
    const file = await exportFrom(shared.b, 'b-1');
    return { ...shared, file, before: await items(shared.a.vault), after: await items(shared.b.vault) };
  }
  const stops: [string, (phase: ImportFault, count?: number) => boolean, 'before' | 'after'][] = [
    ['before the journal is written', (phase) => phase === 'staged', 'before'],
    ['halfway through putting files in place', (phase, count) => phase === 'renaming' && count === 2, 'after'],
  ];

  it.each(stops)('opens a Vault whose process stopped %s as a whole state', async (_name, at, expected) => {
    const { root, a, file, before, after } = await prepared();
    // A copy of the Vault taken at the stop is what a later start finds.
    const stopped = await machine('stopped', root);
    await using(a, async (workspace) => { await importFile(workspace, file); }, {
      importFaults: async (phase, count) => { if (at(phase, count)) await cp(a.vault, stopped.vault, { recursive: true }); },
    });
    expect(await workFolders(stopped.vault)).toHaveLength(1);
    await using(stopped, async (workspace) => {
      expect(await workFolders(stopped.vault)).toEqual([]);
      expect(await items(stopped.vault)).toEqual(expected === 'before' ? before : after);
      if (expected === 'after') {
        // The index was rebuilt.
        expect((await workspace.search.search({ query: `${D5} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D5}`]);
      }
      expect((await workspace.previewImport(file)).merge).toEqual(expected === 'before' ? changedCounts : counts({}));
    });
  });

  it.each(stops)('opens a Vault whose process stopped %s as a whole state when it is opened as another Vault', async (_name, at, expected) => {
    const { root, a, file, before, after } = await prepared();
    const stopped = await machine('stopped', root);
    await using(a, async (workspace) => { await importFile(workspace, file); }, {
      importFaults: async (phase, count) => { if (at(phase, count)) await cp(a.vault, stopped.vault, { recursive: true }); },
    });
    const c = await machine('C', root);
    await using(c, async (workspace) => {
      await workspace.openOther(stopped.vault); await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'completed', operation: 'open', vaultPath: stopped.vault });
      expect(await workFolders(stopped.vault)).toEqual([]);
      expect(await items(stopped.vault)).toEqual(expected === 'before' ? before : after);
      if (expected === 'after') {
        expect((await workspace.search.search({ query: `${D5} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D5}`]);
      }
      expect((await workspace.previewImport(file)).merge).toEqual(expected === 'before' ? changedCounts : counts({}));
    });
  });

  it.each(stops)('drops or finishes an import that fails %s, reporting what happened, then accepts work again', async (_name, at, expected) => {
    const { a, file, before, after } = await prepared();
    await using(a, async (workspace) => {
      await importFile(workspace, file).catch(() => undefined);
      if (expected === 'before') {
        expect(workspace.status()).toMatchObject({ state: 'error', operation: 'import' });
      } else {
        // Past the journal the import is carried out, so it is reported as done.
        expect(workspace.status()).toMatchObject({
          state: 'completed', operation: 'import', errorCode: null, result: { importMode: 'merge', imported: changedCounts },
        });
        expect(workspace.status().message).toContain('匯入完成：文件：新增 1、更新 1、刪除 1；訂閱：新增 1、更新 1、刪除 1');
        expect((await workspace.search.search({ query: `${D5} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D5}`]);
      }
      expect(await workFolders(a.vault)).toEqual([]);
      expect(await items(a.vault)).toEqual(expected === 'before' ? before : after);
      expect(() => workspace.enterWrite()()).not.toThrow();
      expect((await workspace.previewImport(file)).merge).toEqual(expected === 'before' ? changedCounts : counts({}));
    }, { importFaults: (phase, count) => { if (at(phase, count)) throw new Error('disk stopped'); } });
  });

  it('rebuilds the search index when updating it after an import fails, and reports a done import when that fails too', async () => {
    const { a, file, after } = await prepared();
    const failing = { index: false, rebuild: false };
    const createSearch = async (destination: string) => {
      const search = fakeSearch(destination);
      return {
        search: {
          ...search,
          index: async (document: SavedDocument) => { if (failing.index) throw new Error('index stopped'); await search.index(document); },
          rebuild: async () => { if (failing.rebuild) throw new Error('index stopped'); await search.rebuild(); },
        },
        close: async () => undefined,
      };
    };
    const shared = await temp();
    await cp(a.vault, path.join(shared, 'A'), { recursive: true });
    await using(a, async (workspace) => {
      failing.index = true;
      const { status } = await importFile(workspace, file);
      expect(status).toMatchObject({ state: 'completed' });
      expect(status.result!.searchRebuildNeeded).toBeUndefined();
      expect((await workspace.search.search({ query: `${D5} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D5}`]);
    }, { createSearch });
    expect(await items(a.vault)).toEqual(after);

    // The same import on a copy taken before it, with the rebuild failing as well.
    const copy: Machine = { ...a, vault: path.join(shared, 'A') };
    await rm(path.join(a.profile, 'vault-selection.json'), { force: true });
    await using(copy, async (workspace) => {
      failing.index = true; failing.rebuild = true;
      const { status } = await importFile(workspace, file);
      expect(status).toMatchObject({
        state: 'completed', errorCode: null, result: { importMode: 'merge', searchRebuildNeeded: true, imported: changedCounts },
      });
      expect(status.message).toContain('匯入已完成，搜尋索引需要重建');
      expect(() => workspace.enterWrite()()).not.toThrow();
    }, { createSearch });
    expect(await items(copy.vault)).toEqual(after);
  });

  it('answers reads with vault_busy while files are put in place', async () => {
    const { a, file } = await prepared();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    await using(a, async (workspace) => {
      const app = await createHttpApp({ collector: workspace.collector, transfer: workspace });
      try {
        const preview = await workspace.previewImport(file);
        workspace.applyImport(preview.id, 'merge');
        await expect.poll(() => reached).toBe(true);
        const read = await app.inject('/api/documents');
        expect(read.statusCode).toBe(409);
        expect(read.json()).toMatchObject({ error: { code: 'vault_busy' } });
        expect((await app.inject('/api/vault/status')).statusCode).toBe(200);
        release(); await settled(workspace);
        expect((await app.inject('/api/documents')).statusCode).toBe(200);
      } finally { await app.close(); }
    }, { importFaults: async (phase, count) => { if (phase === 'renaming' && count === 1) { reached = true; await held; } } });
  });
});

describe('collection during an import (X77-A12)', () => {
  it('can be cancelled while it waits for a running step, writing nothing', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    const before = await items(a.vault);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      const job = await workspace.jobs.submitVideo('https://www.youtube.com/watch?v=bbbbbbbbbb1');
      await expect.poll(() => workspace.jobs.get(job.job.id)?.state).toBe('running');
      workspace.applyImport(preview.id, 'merge');
      expect(workspace.status().state).toBe('waiting');
      expect(workspace.cancelWait()).toMatchObject({ state: 'idle' });
      release();
      await workspace.jobs.whenSettled(job.job.id);
    }, { capture: { capture: async (target) => { await waiting; return video(target.videoId); } } });
    expect(await preImports(a)).toEqual([]);
    const now = await items(a.vault);
    now.delete('document:youtube:bbbbbbbbbb1');
    expect(now).toEqual(before);
  });

  it('starts no new step while it applies, then goes on; a queued check of a removed subscription writes nothing back', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const listed: string[] = [];
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      const runs = await workspace.channels.startRun({ trigger: 'manual', channelIds: ['UC123', 'UC456'] });
      await expect.poll(() => listed).toEqual(['UC123']);
      workspace.applyImport(preview.id, 'merge');
      expect(workspace.status().state).toBe('waiting');
      release();
      await settled(workspace);
      expect(workspace.status().state).toBe('completed');
      await Promise.all(runs.map((run) => workspace.jobs.whenSettled(run.job.id)));
      // The queued check of the subscription the import removed never ran.
      expect(listed).toEqual(['UC123']);
      expect((await workspace.channels.listChannels()).map((row) => row.id).sort()).toEqual(['UC123', 'UC789']);
    }, {
      jobLimits: { discovery: 1 },
      channelSource: {
        resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }),
        listVideos: async (target) => {
          listed.push(target.id);
          if (listed.length === 1) await waiting;
          return [];
        },
      },
    });
    expect((await channels(a.vault)).map((row) => row.id).sort()).toEqual(['UC123', 'UC789']);
  });
});

describe('a comparison the Vault outdated (X77-A13)', () => {
  it('asks to compare again when the local side changes after the comparison', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    const before = await items(a.vault);
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      await modify(a.vault, D3, '比對後才改的段落', at(9));
      workspace.applyImport(preview.id, 'merge'); await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'error', errorCode: 'invalid_request', message: expect.stringContaining('重新選擇') });
      expect(() => workspace.applyImport(preview.id, 'merge')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    });
    expect(await preImports(a)).toEqual([]);
    const now = await items(a.vault);
    now.delete(`document:youtube:${D3}`); before.delete(`document:youtube:${D3}`);
    expect(now).toEqual(before);
  });
});

describe('creating a Vault from an export file (X77-A15)', () => {
  it('gives the new Vault its own ID, the export\'s content and the export\'s collection switch', async () => {
    const { a, b } = await pair();
    expect(await readVaultId(b.vault)).not.toBe(await readVaultId(a.vault));
    expect((await readdir(b.vault)).sort()).toEqual([VAULT_MARKER, 'documents', 'settings'].sort());
    expect(await scheduleOn(b.vault)).toBe(true);
    expect(await items(b.vault)).toEqual(await items(a.vault));
    expect(existsSync(path.join(b.profile, IMPORT_JOURNAL))).toBe(true);

    // A paused Vault's export creates a paused Vault.
    await new JsonChannelScheduleStore(a.vault).save({ enabled: false });
    const c = await machine('C', path.dirname(path.dirname(a.vault)));
    await importAsNew(c, await exportFrom(a, 'a-paused'));
    expect(await scheduleOn(c.vault)).toBe(false);
  });

  it('refuses an invalid file, a folder with content or a working folder, leaving the folder as it was', async () => {
    const { root, a, first } = await pair();
    const c = await machine('C', root);
    const empty = path.join(root, 'Empty');
    await mkdir(empty); await writeFile(path.join(empty, '.DS_Store'), '');
    const full = path.join(root, 'Full');
    await mkdir(full); await writeFile(path.join(full, 'note.txt'), 'mine');
    const bad = await fileOf(root, 'bad.zip', await tampered(await readFile(first), `documents/youtube/${D1}.md`, 'changed'));
    const options = { profilePath: c.profile, createdBy: 'XR Collector test' };
    for (const [packageFile, folder, message] of [
      [bad, empty, '不一致'], [path.join(root, 'old.xr-vault'), empty, '.zip'], [path.join(root, 'none.zip'), empty, '找不到'],
      [first, full, '其他檔案'], [first, `${empty}.importing-${randomUUID()}`, '暫存資料夾'], [first, 'relative', '完整路徑'],
    ] as const) {
      await expect(importNewVault({ ...options, packageFile, folder }), `${packageFile} → ${folder}`)
        .rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
    }
    expect(await readdir(empty)).toEqual(['.DS_Store']);
    expect(await readdir(full)).toEqual(['note.txt']);
    expect((await readdir(root)).filter((name) => name.includes('.importing-'))).toEqual([]);
    expect(existsSync(path.join(c.profile, IMPORT_JOURNAL))).toBe(false);
    expect(await readVaultId(a.vault)).toBeTruthy();
  });

  it('takes back a new Vault a stop left after the rename, unless the selection names it', async () => {
    const { root, first } = await pair();
    const c = await machine('C', root); await seed(c.vault);
    const target = path.join(root, 'Imported');
    const journalFile = path.join(c.profile, IMPORT_JOURNAL);
    const stoppedAfterRename = async () => {
      await importNewVault({ packageFile: first, folder: target, profilePath: c.profile, createdBy: 'XR Collector test' });
      return JSON.parse(await readFile(journalFile, 'utf8'));
    };
    await mkdir(target);
    expect(await stoppedAfterRename()).toMatchObject({ placed: true, emptyTarget: true, marker: await markerDigest(target) });
    await using(c, async () => undefined);
    // The import had replaced an empty folder, which comes back.
    expect(await readdir(target)).toEqual([]);
    expect(existsSync(journalFile)).toBe(false);

    // A folder at the target that the import did not write is left alone.
    await rm(target, { recursive: true });
    await stoppedAfterRename();
    await rm(path.join(target, VAULT_MARKER));
    await writeVaultMarker(target, 'another program');
    await using(c, async () => undefined);
    expect(await readdir(target)).toContain('documents');

    // Once the selection names the new Vault, the import is complete and the folder stays.
    await rm(target, { recursive: true });
    await stoppedAfterRename();
    await new VaultSelection(path.join(c.profile, 'vault-selection.json')).write(target);
    await using(c, async (workspace) => { expect(workspace.status().vaultPath).toBe(target); });
    expect(await readdir(target)).toContain('documents');
    expect(existsSync(journalFile)).toBe(false);
  });
  it('keeps the import journal while the new Vault opens before the selection names it, so a stop there takes it back', async () => {
    const { root, first } = await pair();
    const c = await machine('C', root); await seed(c.vault);
    const target = path.join(root, 'Imported');
    const journalFile = path.join(c.profile, IMPORT_JOURNAL);
    await importNewVault({ packageFile: first, folder: target, profilePath: c.profile, createdBy: 'XR Collector test' });
    // Onboarding opens the new Vault, then the program stops before the selection is written.
    await using(c, async (workspace) => { expect(workspace.status().vaultPath).toBe(target); }, { root: target, pendingImport: true });
    expect(existsSync(journalFile)).toBe(true);
    await using(c, async (workspace) => { expect(workspace.status().vaultPath).toBe(c.vault); });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(journalFile)).toBe(false);
  });
});

describe('export and import over HTTP (X77-A14)', () => {
  it('exports, compares, applies and cancels files named by path, for the app and an authorized Agent alike', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      for (const agentToken of [undefined, 'test-token']) {
        const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, ...(agentToken ? { agentToken } : {}) });
        const headers = agentToken ? { authorization: `Bearer ${agentToken}` } : {};
        try {
          const target = path.join(a.exports, `${agentToken ?? 'ui'}.zip`);
          const exported = await app.inject({ method: 'POST', url: '/api/vault/export', headers, payload: { path: target } });
          expect(exported.json()).toMatchObject({ state: 'completed', result: { exportPath: target } });
          expect(exported.json()).not.toHaveProperty('lastSync');
          const repeat = await app.inject({ method: 'POST', url: '/api/vault/export', headers, payload: { path: target } });
          expect(repeat.json()).toMatchObject({ error: { code: 'file_exists' } });
          const named = await app.inject({ method: 'POST', url: '/api/vault/export', headers, payload: { path: path.join(a.exports, 'x.xr-vault') } });
          expect(named.json()).toMatchObject({ error: { code: 'invalid_request', message: '匯出檔名必須以 .zip 結尾。' } });
          for (const [value, message] of [[path.join(a.root, 'none.zip'), '找不到這個匯出檔。'], [path.join(a.root, 'b.xr-vault'), '只能匯入 XR Collector 的 .zip 匯出檔。']]) {
            const refused = await app.inject({ method: 'POST', url: '/api/vault/import/preview', headers, payload: { path: value } });
            expect(refused.json()).toMatchObject({ error: { code: 'invalid_request', message } });
          }
          const preview = await app.inject({ method: 'POST', url: '/api/vault/import/preview', headers, payload: { path: file } });
          expect(preview.statusCode).toBe(200);
          expect(preview.json()).toEqual({
            id: expect.any(String), package: { fileName: 'b-1.zip', exportedAt: expect.any(String), machine: 'B' },
            merge: changedCounts, replace: changedCounts, localNewer: 0, mergeRecords: false,
          });
          const { id } = preview.json();
          if (!agentToken) {
            expect((await app.inject({ method: 'POST', url: '/api/vault/import/cancel', headers, payload: { id } })).json()).toEqual({ cancelled: true });
            expect((await app.inject({ method: 'POST', url: '/api/vault/import/apply', headers, payload: { id, mode: 'merge' } })).json())
              .toMatchObject({ error: { code: 'invalid_request' } });
            continue;
          }
          const mode = await app.inject({ method: 'POST', url: '/api/vault/import/apply', headers, payload: { id, mode: 'other' } });
          expect(mode.statusCode).toBe(400);
          const apply = await app.inject({ method: 'POST', url: '/api/vault/import/apply', headers, payload: { id, mode: 'merge' } });
          expect(apply.statusCode).toBe(202);
          await settled(workspace);
          expect((await app.inject({ method: 'GET', url: '/api/vault/status', headers })).json())
            .toMatchObject({ state: 'completed', operation: 'import', result: { importMode: 'merge', imported: changedCounts } });
        } finally { await app.close(); }
      }
    });
    expect(await items(a.vault)).toEqual(await items(b.vault));
  });

  it('only reads the Vault when exporting, and names the Vault and machine the file came from', async () => {
    const { a } = await pair();
    const listing = async () => (await readdir(a.vault, { recursive: true })).sort();
    const before = await listing();
    const file = await exportFrom(a, 'a-2');
    expect(await listing()).toEqual(before);
    const manifest = await manifestOf(await readFile(file));
    expect(manifest.source).toEqual({ vaultId: await readVaultId(a.vault), machine: 'A' });
    expect(manifest).not.toHaveProperty('sync');
  });

  it('documents the export and import contract for Agents', async () => {
    const skill = await readFile(path.resolve('skills/xr-collector-agent/SKILL.md'), 'utf8');
    for (const term of [
      '/api/vault/export/suggestion', '/api/vault/import/preview', '/api/vault/import/apply', '/api/vault/import/cancel', '"packagePath"',
      '`file_exists`', '`transfer_cancelled`', '`vault.imported`', '"mode":"merge"', '"mode":"replace"', '`localNewer`', '`updated_at`',
      '`removed`', '.zip', '`searchRebuildNeeded: true`', '/api/vault/cancel', '`errorCode`', '"action":"import"',
    ]) {
      expect(skill, term).toContain(term);
    }
    expect(skill).not.toMatch(/\/api\/vault\/(restore|merge)|同步點|situation|replaceLoses|lastSync/u);
  });
});

describe('subscription change and removal times', () => {
  it('stamps a subscription when a person changes its name, address, pause or settings, and not for collection progress', async () => {
    const root = await temp();
    const store = new JsonChannelStore(root);
    await store.add(channel('UC123'));
    expect((await store.list())[0]!.updatedAt).toBe('2026-09-18T00:00:00.000Z');
    const stamp = async () => (await store.list())[0]!.updatedAt;
    await store.update('UC123', { lastCheckedAt: '2026-10-18T00:00:00.000Z', nextCheckAt: null, outOfRange: [] });
    expect(await stamp()).toBe('2026-09-18T00:00:00.000Z');
    let previous = await stamp();
    for (const change of [
      () => store.update('UC123', { title: '新名稱' }), () => store.update('UC123', { url: 'https://www.youtube.com/@new' }),
      () => store.setEnabled('UC123', false), () => store.update('UC123', { settings: { ...settings, backfillMaxItems: 5 } }),
    ]) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await change();
      const now = await stamp();
      expect(now! > previous!).toBe(true);
      previous = now;
    }
  });

  it('records a removal with the store clock and lifts it when the channel is subscribed again', async () => {
    const root = await temp();
    await store(root).add(channel('UC123'));
    expect(await store(root, at(3)).remove('UC123')).toBe(true);
    expect(await store(root).removals()).toEqual([{ id: 'UC123', title: '頻道 UC123', url: 'https://www.youtube.com/channel/UC123', removedAt: at(3) }]);
    expect(await store(root).remove('UC123')).toBe(false);
    await store(root).add(channel('UC123', { addedAt: at(4) }));
    expect(await store(root).removals()).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, 'settings/youtube-channels.json'), 'utf8'))).not.toHaveProperty('removed');
  });
});

describe('the default export folder', () => {
  it('lies in Documents on each platform unless XR_COLLECTOR_EXPORT_DIR names another', () => {
    vi.stubEnv('XR_COLLECTOR_EXPORT_DIR', '');
    try {
      expect(exportFolder('C:\\Users\\me\\Documents', path.win32)).toBe('C:\\Users\\me\\Documents\\XR Collector 匯出');
      expect(exportFolder('/Users/me/Documents', path.posix)).toBe('/Users/me/Documents/XR Collector 匯出');
      vi.stubEnv('XR_COLLECTOR_EXPORT_DIR', '/tmp/xr-exports');
      expect(exportFolder('/Users/me/Documents')).toBe(path.resolve('/tmp/xr-exports'));
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('the backup folder', () => {
  it('lies in Documents on each platform unless XR_COLLECTOR_BACKUP_DIR names another', () => {
    vi.stubEnv('XR_COLLECTOR_BACKUP_DIR', '');
    try {
      expect(backupFolder('C:\\Users\\me\\Documents', path.win32)).toBe('C:\\Users\\me\\Documents\\XR Collector 備份');
      expect(backupFolder('/Users/me/Documents', path.posix)).toBe('/Users/me/Documents/XR Collector 備份');
      vi.stubEnv('XR_COLLECTOR_BACKUP_DIR', '/tmp/xr-backups');
      expect(backupFolder('/Users/me/Documents')).toBe(path.resolve('/tmp/xr-backups'));
    } finally { vi.unstubAllEnvs(); }
  });
});

it('refuses an export file the manifest of which does not match its content, with the Vault unchanged', async () => {
  const { a, b } = await pair();
  await changeB(b);
  const file = await exportFrom(b, 'b-1');
  const bad = await fileOf(a.root, 'bad.zip', await tampered(await readFile(file), `documents/youtube/${D5}.md`, 'changed'));
  const empty = await fileOf(a.root, 'empty.zip', await packageOf([]));
  const before = await items(a.vault);
  await using(a, async (workspace) => {
    await expect(workspace.previewImport(bad)).rejects.toMatchObject({ code: 'invalid_request' });
    // An export of an empty Vault shares nothing with A, so nothing is added and nothing removed.
    expect(await workspace.previewImport(empty)).toMatchObject({ merge: counts({}), localNewer: 7 });
  });
  expect(await items(a.vault)).toEqual(before);
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('updates real Meilisearch with what an import wrote and removed, and keeps it after restart', async () => {
  const { a, b } = await pair();
  await changeB(b);
  await modify(b.vault, D3, '匯入後的珊瑚觀察', at(2));
  const file = await exportFrom(b, 'b-1');
  const real = { searchBinary: path.resolve('resources/bin/mac/meilisearch'), createSearch: undefined };
  const ids = async (workspace: VaultWorkspace, query: string) => (await workspace.search.search({ query })).hits.map((hit) => hit.id);
  await using(a, async (workspace) => {
    await expect.poll(() => workspace.search.status().state, { timeout: 15_000 }).toBe('ready');
    expect(await ids(workspace, `${D2}`)).toContain(`youtube:${D2}`);
    await importFile(workspace, file);
    expect(workspace.status().state).toBe('completed');
    await expect.poll(() => ids(workspace, '珊瑚觀察'), { timeout: 10_000 }).toEqual([`youtube:${D3}`]);
    await expect.poll(() => ids(workspace, `${D5} 的字幕`), { timeout: 10_000 }).toContain(`youtube:${D5}`);
    await expect.poll(() => ids(workspace, `${D2} 的字幕`), { timeout: 10_000 }).not.toContain(`youtube:${D2}`);
  }, real);
  await using(a, async (workspace) => {
    await expect.poll(() => workspace.search.status().state, { timeout: 15_000 }).toBe('ready');
    expect(await ids(workspace, '珊瑚觀察')).toEqual([`youtube:${D3}`]);
  }, real);
}, 90_000);

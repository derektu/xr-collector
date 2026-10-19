import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonChannelScheduleStore } from '../../src/channels/json-channel-schedule-store.js';
import { JsonChannelStore } from '../../src/channels/json-channel-store.js';
import { Collector } from '../../src/core/collector.js';
import type { ImportChoice, SavedDocument } from '../../src/core/types.js';
import { JobStore } from '../../src/jobs/job-store.js';
import { createHttpApp } from '../../src/server/app.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { SYNC_FILE, SYNC_HISTORY } from '../../src/vault/sync-points.js';
import { exportFolder, IMPORT_JOURNAL, markerDigest } from '../../src/vault/transfer-files.js';
import { readVaultId, VAULT_MARKER, writeVaultMarker } from '../../src/vault/vault-directory.js';
import { importNewVault, type ImportFault } from '../../src/vault/vault-import.js';
import { registeredFiles, registeredSource } from '../../src/vault/vault-package.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { itemStates, syncItems } from '../../src/vault/vault-sync.js';
import type { VaultWorkspace, WorkspaceOptions } from '../../src/vault/workspace.js';
import { channel, cleanUp, fakeSearch, fileOf, importFile, machine, open, seed, settings, settled, temp, video, type Machine } from './exchange-fixtures.js';
import { manifestOf, packageFiles, packageOf, tampered } from './package-fixtures.js';

afterEach(cleanUp);

/** Video IDs of the documents the two machines exchange. */
const D1 = 'aaaaaaaaaa1'; const D2 = 'aaaaaaaaaa2'; const D3 = 'aaaaaaaaaa3'; const D4 = 'aaaaaaaaaa4';
const doc = (id: string) => `document:youtube:${id}`;
const docPath = (root: string, id: string) => path.join(root, `documents/youtube/${id}.md`);

/** The items of a Vault as a sync point records them; equal items mean equal content. */
const items = async (root: string) => syncItems(await itemStates(registeredSource(await registeredFiles(root))));

async function add(root: string, id: string, body?: string) {
  await new MarkdownVault(root).add(video(id, body ? { bodyMarkdown: body } : {}));
}
/** Changes a document's body as an editor would, without collecting it again. */
async function edit(root: string, id: string, text: string) {
  await writeFile(docPath(root, id), `${await readFile(docPath(root, id), 'utf8')}\n${text}\n`);
}
async function remove(root: string, id: string) {
  await new Collector(new MarkdownVault(root)).delete(`youtube:${id}`);
}
const channels = async (root: string) => new JsonChannelStore(root).list();
const scheduleOn = async (root: string) => (await new JsonChannelScheduleStore(root).load()).enabled;

/** Runs `use` on a workspace of the machine and closes it afterwards. */
async function using<T>(at: Machine, use: (workspace: VaultWorkspace) => Promise<T>, overrides: Partial<WorkspaceOptions> = {}): Promise<T> {
  const workspace = await open(at, overrides, false);
  try { return await use(workspace); } finally { await workspace.close(); }
}

/** Exports the machine's Vault by hand, as a sync point, to `<exports>/<name>.zip`. */
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

/**
 * A on 家裡 and B on 公司 sharing one sync point: A holds four documents, two subscriptions and
 * automatic collection on; it exports, and B is created from that export.
 */
async function pair() {
  const root = await temp();
  const a = await machine('A', root); const b = await machine('B', root);
  await seed(a.vault);
  for (const id of [D1, D2, D3]) await add(a.vault, id);
  await new JsonChannelStore(a.vault).add(channel('UC456'));
  const first = await exportFrom(a, 'a-1');
  await importAsNew(b, first);
  return { root, a, b, first };
}

/** B's changes for SYNC-02: one of each kind on documents and subscriptions. */
async function changeB(b: Machine) {
  await add(b.vault, D4);
  await edit(b.vault, D1, 'B 補充的段落');
  await remove(b.vault, D2);
  await new JsonChannelStore(b.vault).add(channel('UC789'));
  await new JsonChannelStore(b.vault).update('UC123', { settings: { ...settings, intervalMinutes: 360 } });
  await new JsonChannelStore(b.vault).remove('UC456');
}

const workFolders = async (root: string) => (await readdir(root)).filter((name) => name.startsWith('.xr-collector-import-'));
const preImports = async (at: Machine) => existsSync(at.exports) ? (await readdir(at.exports)).filter((name) => name.startsWith('XR Collector 匯入前')) : [];

describe('sync points (SYNC-01)', () => {
  it('records each export by hand as a sync point that the export file names, and never packs the sync file', async () => {
    const { a, first } = await pair();
    const history = JSON.parse(await readFile(path.join(a.vault, SYNC_FILE), 'utf8'));
    const manifest = await manifestOf(await readFile(first));
    expect(history.points).toEqual([{ id: expect.any(String), at: manifest.exportedAt, kind: 'export', machine: 'A', items: Object.fromEntries(await items(a.vault)) }]);
    expect(Object.keys(history.points[0].items)).toEqual(expect.arrayContaining([doc(D1), doc('dQw4w9WgXcQ'), 'channel:UC123', 'channel:UC456']));
    expect(manifest.sync).toEqual({ id: history.points[0].id, ancestors: [], vaultId: await readVaultId(a.vault), machine: 'A' });
    expect([...(await packageFiles(await readFile(first))).keys()]).not.toContain(SYNC_FILE);
    expect(manifest.files.map((file) => file.path)).not.toContain(SYNC_FILE);

    await add(a.vault, D4);
    const second = await using(a, async (workspace) => {
      const status = await workspace.exportTo(path.join(a.exports, 'a-2.zip'));
      expect(status.result!.unregisteredFiles).toBe(0);
      expect(status.lastSync).toEqual({ at: expect.any(String), kind: 'export', machine: 'A' });
      return status.result!.exportPath!;
    });
    expect((await manifestOf(await readFile(second))).sync).toMatchObject({ ancestors: [history.points[0].id] });
  });

  it(`keeps the newest ${SYNC_HISTORY} sync points, newest first`, async () => {
    const a = await machine('A'); await seed(a.vault);
    const ids: string[] = [];
    for (let index = 0; index < SYNC_HISTORY + 2; index += 1) {
      await add(a.vault, `bbbbbbbbbb${index}`);
      const file = await exportFrom(a, `a-${index}`);
      ids.unshift(((await manifestOf(await readFile(file))).sync as { id: string }).id);
    }
    const points = JSON.parse(await readFile(path.join(a.vault, SYNC_FILE), 'utf8')).points as { id: string }[];
    expect(points.map((point) => point.id)).toEqual(ids.slice(0, SYNC_HISTORY));
  });

  it('adds no sync point for an export whose content equals the newest one, so backups keep the shared point', async () => {
    const { a, b, first } = await pair();
    const firstId = ((await manifestOf(await readFile(first))).sync as { id: string }).id;
    const before = await readFile(path.join(a.vault, SYNC_FILE), 'utf8');
    const backups: string[] = [];
    for (let index = 0; index < SYNC_HISTORY + 1; index += 1) backups.push(await exportFrom(a, `backup-${index}`));
    expect(await readFile(path.join(a.vault, SYNC_FILE), 'utf8')).toBe(before);
    for (const backup of backups) expect((await manifestOf(await readFile(backup))).sync).toMatchObject({ id: firstId, ancestors: [] });
    // B, created from the first export, still shares a point with A after all those exports.
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => { expect((await workspace.previewImport(file)).situation).toBe('incoming'); });
    // A backup holds the same content as the shared point, so B finds nothing new in it.
    await using(b, async (workspace) => { expect((await workspace.previewImport(backups[0]!)).situation).toBe('nothing'); });
  });

  it('records what the written file holds when the Vault changes while it is written', async () => {
    const { a, first } = await pair();
    const firstId = ((await manifestOf(await readFile(first))).sync as { id: string }).id;
    const points = async () => JSON.parse(await readFile(path.join(a.vault, SYNC_FILE), 'utf8')).points as { id: string; items: Record<string, string> }[];
    /** Runs `during` once, before or after the first export file is written. */
    const racing = (workspace: VaultWorkspace, when: 'before' | 'after', during: () => Promise<void>) => {
      const target = workspace as unknown as { pack: (...args: unknown[]) => Promise<unknown> };
      const pack = target.pack.bind(workspace);
      let ran = false;
      target.pack = async (...args) => {
        if (!ran && when === 'before') { ran = true; await during(); }
        const written = await pack(...args);
        if (!ran && when === 'after') { ran = true; await during(); }
        return written;
      };
    };

    // An edit after the file is written stays out of the sync point, so importing the file never takes it back.
    await edit(a.vault, D1, '匯出前的段落');
    const second = await using(a, async (workspace) => {
      racing(workspace, 'after', () => edit(a.vault, D1, '匯出時才加的段落'));
      return (await workspace.exportTo(path.join(a.exports, 'a-2.zip'))).result!.exportPath!;
    });
    const secondId = ((await manifestOf(await readFile(second))).sync as { id: string }).id;
    expect((await points())[0]).toMatchObject({ id: secondId });
    expect(new Map(Object.entries((await points())[0]!.items))).not.toEqual(await items(a.vault));
    await using(a, async (workspace) => {
      expect(await workspace.previewImport(second)).toMatchObject({ situation: 'nothing', replaceLoses: 1 });
    });

    // A file begun under the newest point's ID that ends up holding other content gets an ID of its own.
    const current = await exportFrom(a, 'a-current');
    const currentId = ((await manifestOf(await readFile(current))).sync as { id: string }).id;
    const third = await using(a, async (workspace) => {
      racing(workspace, 'before', () => add(a.vault, D4));
      return (await workspace.exportTo(path.join(a.exports, 'a-3.zip'))).result!.exportPath!;
    });
    const manifest = await manifestOf(await readFile(third));
    expect(manifest.sync).toMatchObject({ ancestors: [currentId, secondId, firstId] });
    expect((manifest.sync as { id: string }).id).not.toBe(currentId);
    expect((await points()).map((point) => point.id)).toEqual([(manifest.sync as { id: string }).id, currentId, secondId, firstId]);
    expect(new Map(Object.entries((await points())[0]!.items))).toEqual(await items(a.vault));
  });

  it('moves with the Vault', async () => {
    const { a, root } = await pair();
    const target = path.join(root, 'Moved');
    await using(a, async (workspace) => {
      await workspace.move(target); await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'completed', vaultPath: target });
    });
    expect(JSON.parse(await readFile(path.join(target, SYNC_FILE), 'utf8')).points).toHaveLength(1);
  });

  it('treats an unreadable sync file as no shared sync point, records a warning and still opens', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    await writeFile(path.join(a.vault, SYNC_FILE), '{ broken');
    const jobStore = JobStore.memory();
    await using(a, async (workspace) => {
      expect(workspace.status().lastSync).toBeNull();
      const preview = await workspace.previewImport(file);
      expect(preview.situation).toBe('unrelated');
      const events = (await jobStore.activity.query({}, { vaultPath: a.vault })).events;
      expect(events.filter((event) => event.eventType === 'vault.sync_unreadable')).toEqual([
        expect.objectContaining({ severity: 'warning', message: expect.stringContaining('格式錯誤') }),
      ]);
    }, { jobStore });
  });
});

describe('the local side has not changed since the shared sync point (SYNC-02)', () => {
  it('applies every change of the file, keeps local collection progress and the collection switch, and exports first', async () => {
    const { a, b } = await pair();
    await changeB(b);
    // A checks its subscription after the export: progress is no change of content.
    await new JsonChannelStore(a.vault).update('UC123', { lastCheckedAt: '2026-10-18T00:00:00.000Z' });
    // B pauses automatic collection; the switch belongs to each Vault and never travels with an import.
    await new JsonChannelScheduleStore(b.vault).save({ enabled: false });
    const file = await exportFrom(b, 'b-1');
    const before = await items(a.vault);

    await using(a, async (workspace) => {
      const { preview, status } = await importFile(workspace, file);
      expect(preview).toMatchObject({
        situation: 'incoming', conflicts: [], replaceLoses: 0, incoming: { added: 2, modified: 2, removed: 2 },
        package: { fileName: 'b-1.zip', exportedAt: expect.any(String), machine: 'B' },
      });
      expect(status).toMatchObject({
        state: 'completed', operation: 'import', lastSync: { kind: 'import', machine: 'B' },
        result: { importMode: 'merge', imported: { added: 2, modified: 2, removed: 2 }, preImportExportPath: expect.stringContaining(a.exports) },
      });
      expect(status.message).toContain('匯入完成：新增 2、修改 2、刪除 2');
      expect(path.basename(status.result!.preImportExportPath!)).toMatch(/^XR Collector 匯入前 \d{4}-\d{2}-\d{2} \d{6}\.zip$/u);
      // The documents the import wrote or removed are in the search index as they are now.
      expect((await workspace.search.search({ query: `${D4} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D4}`]);
      expect((await workspace.search.search({ query: 'B 補充的段落' })).hits.map((hit) => hit.id)).toEqual([`youtube:${D1}`]);
      await expect(workspace.collector.read(`youtube:${D2}`)).rejects.toMatchObject({ code: 'document_deleted' });
    });

    expect(await items(a.vault)).toEqual(await items(b.vault));
    expect(await items(a.vault)).not.toEqual(before);
    expect(existsSync(docPath(a.vault, D2))).toBe(false);
    expect(JSON.parse(await readFile(path.join(a.vault, DELETIONS_FILE), 'utf8')).deleted.map((record: { sourceId: string }) => record.sourceId)).toEqual([D2]);
    const rows = await channels(a.vault);
    expect(rows.map((row) => row.id).sort()).toEqual(['UC123', 'UC789']);
    expect(rows.find((row) => row.id === 'UC123')).toMatchObject({ settings: { intervalMinutes: 360 }, lastCheckedAt: '2026-10-18T00:00:00.000Z' });
    expect(await scheduleOn(a.vault)).toBe(true);
    expect(await scheduleOn(b.vault)).toBe(false);
    // The import is A's newest sync point: the file's own point, holding the file's items.
    const points = JSON.parse(await readFile(path.join(a.vault, SYNC_FILE), 'utf8')).points;
    expect(points.map((point: { kind: string }) => point.kind)).toEqual(['import', 'export']);
    expect(points[0]).toMatchObject({ id: ((await manifestOf(await readFile(file))).sync as { id: string }).id, machine: 'B' });
    expect(await preImports(a)).toHaveLength(1);
  });
});

describe('both sides changed since the shared sync point (SYNC-03)', () => {
  async function bothChanged() {
    const shared = await pair();
    const { a, b } = shared;
    await edit(a.vault, D1, 'A 的段落'); await edit(b.vault, D1, 'B 的段落');
    await remove(a.vault, D3); await edit(b.vault, D3, 'B 改了 A 刪掉的文件');
    await remove(a.vault, D2); await remove(b.vault, D2);
    await new JsonChannelStore(a.vault).update('UC123', { settings: { ...settings, intervalMinutes: 180 } });
    await new JsonChannelStore(b.vault).update('UC123', { settings: { ...settings, intervalMinutes: 360 } });
    await new JsonChannelStore(a.vault).remove('UC456');
    await new JsonChannelStore(b.vault).update('UC456', { title: 'B 改名的頻道' });
    await add(a.vault, 'aaaaaaaaaaA'); await add(b.vault, 'aaaaaaaaaaB');
    return { ...shared, file: await exportFrom(b, 'b-1') };
  }

  it('takes one-sided changes, lists the items both sides changed differently and applies the choices', async () => {
    const { a, b, file } = await bothChanged();
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview.situation).toBe('both');
      expect(preview.incoming).toEqual({ added: 1, modified: 0, removed: 0 });
      expect(preview.conflicts.map((item) => [item.key, item.kind, item.local.state, item.incoming.state])).toEqual([
        ['channel:UC123', 'channel', 'present', 'present'],
        ['channel:UC456', 'channel', 'absent', 'present'],
        [doc(D1), 'document', 'present', 'present'],
        [doc(D3), 'document', 'deleted', 'present'],
      ]);
      expect(preview.conflicts[0]).toMatchObject({ label: '測試頻道', local: { machine: 'A', time: expect.any(String) }, incoming: { machine: 'B', time: expect.any(String) } });
      expect(preview.conflicts[1]!.label).toBe('B 改名的頻道');
      // Every conflict needs a choice, and only conflicts take one.
      expect(() => workspace.applyImport(preview.id, 'merge', {})).toThrow(expect.objectContaining({ code: 'invalid_request' }));
      expect(() => workspace.applyImport(preview.id, 'merge', { [doc(D4)]: 'local' }))
        .toThrow(expect.objectContaining({ code: 'invalid_request' }));
      const choices: Record<string, ImportChoice> = { 'channel:UC123': 'local', 'channel:UC456': 'incoming', [doc(D1)]: 'incoming', [doc(D3)]: 'local' };
      workspace.applyImport(preview.id, 'merge', choices); await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'completed', result: { imported: { added: 2, modified: 1, removed: 0 } } });
    });
    expect(await readFile(docPath(a.vault, D1), 'utf8')).toContain('B 的段落');
    expect(existsSync(docPath(a.vault, D3))).toBe(false);
    expect(existsSync(docPath(a.vault, 'aaaaaaaaaaA'))).toBe(true);
    expect(existsSync(docPath(a.vault, 'aaaaaaaaaaB'))).toBe(true);
    const rows = await channels(a.vault);
    expect(rows.find((row) => row.id === 'UC123')!.settings.intervalMinutes).toBe(180);
    expect(rows.find((row) => row.id === 'UC456')!.title).toBe('B 改名的頻道');

    // A's choices travel back: B has not changed since its export, so it takes A's export as a whole.
    const back = await exportFrom(a, 'a-2');
    await using(b, async (workspace) => {
      const { preview, status } = await importFile(workspace, back);
      expect(preview.situation).toBe('incoming');
      expect(status.state).toBe('completed');
    });
    expect(await items(b.vault)).toEqual(await items(a.vault));
  });

  it('asks to compare again when the local side changes after the comparison', async () => {
    const { a, file } = await bothChanged();
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      await edit(a.vault, 'aaaaaaaaaaA', '比對後才加的段落');
      const choices = Object.fromEntries(preview.conflicts.map((item) => [item.key, 'local' as const]));
      workspace.applyImport(preview.id, 'merge', choices); await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'error', errorCode: 'invalid_request', message: expect.stringContaining('重新選擇') });
      expect(() => workspace.applyImport(preview.id, 'merge', choices)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    });
    expect(await preImports(a)).toEqual([]);
  });
});

describe('no shared sync point (SYNC-04)', () => {
  it('only adds, keeps local items and lists items both sides hold differently', async () => {
    const root = await temp();
    const a = await machine('A', root); const c = await machine('C', root);
    await seed(a.vault); await add(a.vault, D1); await add(a.vault, 'aaaaaaaaaaA');
    await seed(c.vault); await add(c.vault, 'aaaaaaaaaaC');
    await add(c.vault, D1); await remove(c.vault, D1);
    await add(c.vault, 'aaaaaaaaaaX'); await remove(c.vault, 'aaaaaaaaaaX');
    await new JsonChannelStore(c.vault).update('UC123', { settings: { ...settings, intervalMinutes: 30 } });
    const file = await exportFrom(c, 'c-1');
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview.situation).toBe('unrelated');
      expect(preview.conflicts.map((item) => item.key)).toEqual(['channel:UC123', doc(D1)]);
      expect(preview.conflicts[1]).toMatchObject({ local: { state: 'present' }, incoming: { state: 'deleted' } });
      expect(preview.incoming).toEqual({ added: 1, modified: 0, removed: 1 });
      expect(preview.replaceLoses).toBe(3);
      workspace.applyImport(preview.id, 'merge', { 'channel:UC123': 'local', [doc(D1)]: 'local' }); await settled(workspace);
      expect(workspace.status().state).toBe('completed');
    });
    for (const id of [D1, 'aaaaaaaaaaA', 'aaaaaaaaaaC', 'dQw4w9WgXcQ']) expect(existsSync(docPath(a.vault, id)), id).toBe(true);
    expect(JSON.parse(await readFile(path.join(a.vault, DELETIONS_FILE), 'utf8')).deleted.map((record: { sourceId: string }) => record.sourceId))
      .toEqual(['aaaaaaaaaaX']);
    expect((await channels(a.vault))[0]!.settings.intervalMinutes).toBe(60);
  });
});

describe('the file holds nothing the Vault lacks (SYNC-05)', () => {
  it('writes nothing for a file already imported, and refuses a merge or a replace that would change nothing', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => { await importFile(workspace, file); });
    const before = await readFile(path.join(a.vault, SYNC_FILE));
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ situation: 'nothing', replaceLoses: 0, incoming: { added: 0, modified: 0, removed: 0 }, conflicts: [] });
      expect(() => workspace.applyImport(preview.id, 'merge', {})).toThrow(expect.objectContaining({ message: '沒有需要匯入的內容。' }));
      expect(() => workspace.applyImport(preview.id, 'replace')).toThrow(expect.objectContaining({ message: '本機內容已與匯入檔相同。' }));
      workspace.cancelImport(preview.id);
      expect(workspace.status()).toMatchObject({ state: 'idle', message: '已取消匯入，資料未變更。' });
    });
    expect(await readFile(path.join(a.vault, SYNC_FILE))).toEqual(before);
    expect(await preImports(a)).toHaveLength(1);
  });

  it('finds an earlier export of its own already included, and replacing goes back to it', async () => {
    const { a, first } = await pair();
    const original = await items(a.vault);
    await add(a.vault, D4); await edit(a.vault, D1, '之後的段落');
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(first);
      expect(preview).toMatchObject({ situation: 'nothing', replaceLoses: 2 });
      workspace.applyImport(preview.id, 'replace'); await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'completed', message: expect.stringContaining('已完全以匯入內容取代') });
    });
    expect(await items(a.vault)).toEqual(original);
  });

  it('undoes an import with the export taken before it', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const original = await items(a.vault);
    const file = await exportFrom(b, 'b-1');
    const backup = await using(a, async (workspace) => (await importFile(workspace, file)).status.result!.preImportExportPath!);
    const manifest = await manifestOf(await readFile(backup));
    expect(manifest.sync).toMatchObject({ id: null, machine: 'A' });
    expect((manifest.sync as { ancestors: string[] }).ancestors).toHaveLength(1);
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(backup);
      expect(preview).toMatchObject({ situation: 'nothing', replaceLoses: 6 });
      workspace.applyImport(preview.id, 'replace'); await settled(workspace);
      expect(workspace.status().state).toBe('completed');
    });
    expect(await items(a.vault)).toEqual(original);
    // The export taken before an import records no sync point.
    const points = JSON.parse(await readFile(path.join(a.vault, SYNC_FILE), 'utf8')).points as { kind: string }[];
    expect(points.map((point) => point.kind)).toEqual(['import', 'import', 'export']);
  });
});

describe('replacing with the file (SYNC-06)', () => {
  it('makes every item what the file holds, reports what the Vault loses and leaves other files and the switch alone', async () => {
    const { a, b } = await pair();
    await edit(a.vault, D1, 'A 的段落'); await add(a.vault, 'aaaaaaaaaaA'); await new JsonChannelStore(a.vault).remove('UC456');
    await edit(b.vault, D2, 'B 的段落');
    await writeFile(path.join(a.vault, 'notes.txt'), '我的筆記');
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      const preview = await workspace.previewImport(file);
      expect(preview).toMatchObject({ situation: 'both', replaceLoses: 3, conflicts: [] });
      workspace.applyImport(preview.id, 'replace'); await settled(workspace);
      expect(workspace.status()).toMatchObject({ state: 'completed', result: { importMode: 'replace', imported: { added: 1, modified: 2, removed: 1 } } });
      expect((await workspace.search.search({ query: 'B 的段落' })).hits.map((hit) => hit.id)).toEqual([`youtube:${D2}`]);
    });
    expect(await items(a.vault)).toEqual(await items(b.vault));
    expect(await readFile(path.join(a.vault, 'notes.txt'), 'utf8')).toBe('我的筆記');
    expect(await scheduleOn(a.vault)).toBe(true);
  });
});

describe('the export before an import (SYNC-07)', () => {
  it('is written, in a folder it creates, before any file of the Vault changes', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    await rm(a.exports, { recursive: true });
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
    const manifest = await manifestOf(await readFile(path.join(a.exports, seen[0]!)));
    expect(manifest.summary).toMatchObject({ documents: 4, subscriptions: 2 });
  });

  it('stops the import with the Vault unchanged when the export cannot be written', async () => {
    const { a, b } = await pair();
    await changeB(b);
    const file = await exportFrom(b, 'b-1');
    const blocked = path.join(a.root, 'blocked');
    await writeFile(blocked, 'a file where the export folder should be');
    const before = await items(a.vault);
    const sync = await readFile(path.join(a.vault, SYNC_FILE));
    await using(a, async (workspace) => {
      await importFile(workspace, file);
      expect(workspace.status()).toMatchObject({ state: 'error', operation: 'import' });
      expect(() => workspace.enterWrite()()).not.toThrow();
    }, { exportFolder: path.join(blocked, 'exports') });
    expect(await items(a.vault)).toEqual(before);
    expect(await readFile(path.join(a.vault, SYNC_FILE))).toEqual(sync);
    expect(await workFolders(a.vault)).toEqual([]);
  });
});

describe('the same video on both machines (SYNC-08)', () => {
  it('is neither a conflict nor a change when only the collection time differs', async () => {
    const { a, b } = await pair();
    await new MarkdownVault(a.vault, { now: () => new Date('2026-10-01T00:00:00.000Z') }).add(video('samevideo01'));
    await new MarkdownVault(b.vault, { now: () => new Date('2026-10-05T00:00:00.000Z') }).add(video('samevideo01'));
    expect(await readFile(docPath(a.vault, 'samevideo01'))).not.toEqual(await readFile(docPath(b.vault, 'samevideo01')));
    const file = await exportFrom(b, 'b-1');
    await using(a, async (workspace) => {
      expect(await workspace.previewImport(file)).toMatchObject({ situation: 'nothing', conflicts: [], incoming: { added: 0, modified: 0, removed: 0 }, replaceLoses: 0 });
    });
  });
});

describe('an import stopped while it applies (SYNC-09)', () => {
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
    ['before the sync file is put in place', (phase) => phase === 'before-sync', 'after'],
  ];

  it.each(stops)('opens a Vault whose process stopped %s as a whole state, its sync point matching', async (_name, at, expected) => {
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
        // The index was rebuilt, and the sync point holds what the Vault holds.
        expect((await workspace.search.search({ query: `${D4} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D4}`]);
        expect(workspace.status().lastSync).toMatchObject({ kind: 'import', machine: 'B' });
      }
      expect((await workspace.previewImport(file)).situation).toBe(expected === 'before' ? 'incoming' : 'nothing');
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
        expect((await workspace.search.search({ query: `${D4} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D4}`]);
        expect(workspace.status().lastSync).toMatchObject({ kind: 'import', machine: 'B' });
      }
      expect((await workspace.previewImport(file)).situation).toBe(expected === 'before' ? 'incoming' : 'nothing');
    });
  });

  it.each(stops)('drops or finishes an import that fails %s, reporting what happened, then accepts work again', async (_name, at, expected) => {
    const { a, file, before, after } = await prepared();
    await using(a, async (workspace) => {
      await importFile(workspace, file).catch(() => undefined);
      if (expected === 'before') {
        expect(workspace.status()).toMatchObject({ state: 'error', operation: 'import', lastSync: { kind: 'export', machine: 'A' } });
      } else {
        // Past the journal the import is carried out, so it is reported as done.
        expect(workspace.status()).toMatchObject({
          state: 'completed', operation: 'import', errorCode: null, lastSync: { kind: 'import', machine: 'B' },
          result: { importMode: 'merge', imported: { added: 2, modified: 2, removed: 2 } },
        });
        expect(workspace.status().message).toContain('匯入完成：新增 2、修改 2、刪除 2');
        expect((await workspace.search.search({ query: `${D4} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D4}`]);
      }
      expect(await workFolders(a.vault)).toEqual([]);
      expect(await items(a.vault)).toEqual(expected === 'before' ? before : after);
      expect(() => workspace.enterWrite()()).not.toThrow();
      expect((await workspace.previewImport(file)).situation).toBe(expected === 'before' ? 'incoming' : 'nothing');
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
      expect(status).toMatchObject({ state: 'completed', lastSync: { kind: 'import', machine: 'B' } });
      expect(status.result!.searchRebuildNeeded).toBeUndefined();
      expect((await workspace.search.search({ query: `${D4} 的字幕` })).hits.map((hit) => hit.id)).toEqual([`youtube:${D4}`]);
    }, { createSearch });
    expect(await items(a.vault)).toEqual(after);

    // The same import on a copy taken before it, with the rebuild failing as well.
    const copy: Machine = { ...a, vault: path.join(shared, 'A') };
    await rm(path.join(a.profile, 'vault-selection.json'), { force: true });
    await using(copy, async (workspace) => {
      failing.index = true; failing.rebuild = true;
      const { status } = await importFile(workspace, file);
      expect(status).toMatchObject({
        state: 'completed', errorCode: null, lastSync: { kind: 'import', machine: 'B' },
        result: { importMode: 'merge', searchRebuildNeeded: true, imported: { added: 2, modified: 2, removed: 2 } },
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
        workspace.applyImport(preview.id, 'merge', {});
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

describe('collection during an import (SYNC-10)', () => {
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
      workspace.applyImport(preview.id, 'merge', {});
      expect(workspace.status().state).toBe('waiting');
      expect(workspace.cancelWait()).toMatchObject({ state: 'idle' });
      release();
      await workspace.jobs.whenSettled(job.job.id);
    }, { capture: { capture: async (target) => { await waiting; return video(target.videoId); } } });
    expect(await preImports(a)).toEqual([]);
    const now = await items(a.vault);
    now.delete(doc('bbbbbbbbbb1'));
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
      workspace.applyImport(preview.id, 'merge', {});
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

describe('creating a Vault from an export file (SYNC-11)', () => {
  it('gives the new Vault its own ID, the export as its sync point and the export\'s collection switch', async () => {
    const { a, b, first } = await pair();
    expect(await readVaultId(b.vault)).not.toBe(await readVaultId(a.vault));
    const points = JSON.parse(await readFile(path.join(b.vault, SYNC_FILE), 'utf8')).points;
    expect(points).toEqual([expect.objectContaining({ id: ((await manifestOf(await readFile(first))).sync as { id: string }).id, kind: 'import', machine: 'A' })]);
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

describe('export and import over HTTP (SYNC-12)', () => {
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
          const { id, situation } = preview.json();
          if (!agentToken) {
            expect(situation).toBe('incoming');
            expect((await app.inject({ method: 'POST', url: '/api/vault/import/cancel', headers, payload: { id } })).json()).toEqual({ cancelled: true });
            expect((await app.inject({ method: 'POST', url: '/api/vault/import/apply', headers, payload: { id, mode: 'merge', choices: {} } })).json())
              .toMatchObject({ error: { code: 'invalid_request' } });
            continue;
          }
          const apply = await app.inject({ method: 'POST', url: '/api/vault/import/apply', headers, payload: { id, mode: 'merge', choices: {} } });
          expect(apply.statusCode).toBe(202);
          await settled(workspace);
          expect((await app.inject({ method: 'GET', url: '/api/vault/status', headers })).json())
            .toMatchObject({ state: 'completed', operation: 'import', result: { importMode: 'merge' } });
          const mode = await app.inject({ method: 'POST', url: '/api/vault/import/apply', headers, payload: { id, mode: 'other' } });
          expect(mode.statusCode).toBe(400);
        } finally { await app.close(); }
      }
    });
    expect(await items(a.vault)).toEqual(await items(b.vault));
  });

  it('documents the export and import contract for Agents', async () => {
    const skill = await readFile(path.resolve('skills/xr-collector-agent/SKILL.md'), 'utf8');
    for (const term of [
      '/api/vault/export/suggestion', '/api/vault/import/preview', '/api/vault/import/apply', '/api/vault/import/cancel', '"packagePath"',
      '`file_exists`', '`transfer_cancelled`', '`vault.imported`', '`vault.sync_unreadable`', '"mode":"merge"', '"mode":"replace"', '`situation`',
      '`replaceLoses`', '.zip', `${SYNC_HISTORY} 個同步點`, '自動匯出不記錄同步點', '沿用那個同步點', '`searchRebuildNeeded: true`', '/api/vault/cancel', '`errorCode`', '"action":"import"',
    ]) {
      expect(skill, term).toContain(term);
    }
    expect(skill).not.toMatch(/\/api\/vault\/(restore|merge)/u);
  });
});

describe('subscription change times', () => {
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

it('refuses an export file the manifest of which does not match its content, with the Vault unchanged', async () => {
  const { a, b } = await pair();
  await changeB(b);
  const file = await exportFrom(b, 'b-1');
  const bad = await fileOf(a.root, 'bad.zip', await tampered(await readFile(file), `documents/youtube/${D4}.md`, 'changed'));
  const empty = await fileOf(a.root, 'empty.zip', await packageOf([]));
  const before = await items(a.vault);
  await using(a, async (workspace) => {
    await expect(workspace.previewImport(bad)).rejects.toMatchObject({ code: 'invalid_request' });
    // An export of an empty Vault shares nothing with A, so nothing is added and nothing removed.
    expect(await workspace.previewImport(empty)).toMatchObject({ situation: 'nothing' });
  });
  expect(await items(a.vault)).toEqual(before);
});

it.skipIf(!existsSync(path.resolve('resources/bin/mac/meilisearch')))('updates real Meilisearch with what an import wrote and removed, and keeps it after restart', async () => {
  const { a, b } = await pair();
  await changeB(b);
  await writeFile(docPath(b.vault, D3), (await readFile(docPath(b.vault, D3), 'utf8')).replace(`${D3} 的字幕。`, '匯入後的珊瑚觀察'));
  const file = await exportFrom(b, 'b-1');
  const real = { searchBinary: path.resolve('resources/bin/mac/meilisearch'), createSearch: undefined };
  const ids = async (workspace: VaultWorkspace, query: string) => (await workspace.search.search({ query })).hits.map((hit) => hit.id);
  await using(a, async (workspace) => {
    await expect.poll(() => workspace.search.status().state, { timeout: 15_000 }).toBe('ready');
    expect(await ids(workspace, `${D2}`)).toContain(`youtube:${D2}`);
    await importFile(workspace, file);
    expect(workspace.status().state).toBe('completed');
    await expect.poll(() => ids(workspace, '珊瑚觀察'), { timeout: 10_000 }).toEqual([`youtube:${D3}`]);
    await expect.poll(() => ids(workspace, `${D4} 的字幕`), { timeout: 10_000 }).toContain(`youtube:${D4}`);
    await expect.poll(() => ids(workspace, `${D2} 的字幕`), { timeout: 10_000 }).not.toContain(`youtube:${D2}`);
  }, real);
  await using(a, async (workspace) => {
    await expect.poll(() => workspace.search.status().state, { timeout: 15_000 }).toBe('ready');
    expect(await ids(workspace, '珊瑚觀察')).toEqual([`youtube:${D3}`]);
  }, real);
}, 90_000);

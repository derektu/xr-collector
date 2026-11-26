// Broken, an import between two Vaults loses or brings back documents and subscriptions, previews counts it does not apply,
// or a failed import leaves the Vault half changed without a backup.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { JsonScheduleStore } from '../../../src/domain/subscriptions/schedule-store.js';
import { JsonSubscriptionStore } from '../../../src/domain/subscriptions/subscription-store.js';
import { Collector } from '../../../src/domain/vault/collector.js';
import { DELETIONS_FILE } from '../../../src/domain/vault/deleted-documents.js';
import { MarkdownVault } from '../../../src/domain/vault/markdown-vault.js';
import { readVaultId, VAULT_MARKER } from '../../../src/domain/vault/vault-directory.js';
import { importNewVault } from '../../../src/domain/vault/vault-import.js';
import { itemStates } from '../../../src/domain/vault/vault-merge.js';
import { registeredFiles, registeredSource } from '../../../src/domain/vault/vault-package.js';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import type { VaultWorkspace } from '../../../src/app/runtime/vault-workspace.js';
import type { ImportMode, ImportPreview } from '../../../src/shared/vault/vault-types.js';
import { transcriptDocument } from '../../../src/domain/sources/youtube/server.js';
import { bundledLexicon, bundledMeilisearch, REAL_ENGINE_TAG } from '../../support/real-engine.js';
import { channel, cleanUp, fileOf, importFile, machine, open, seed, settings, temp, video, type Machine, type OpenOverrides } from '../../support/exchange-fixtures.js';
import { manifestOf, tampered, zipEntries } from '../../support/package-fixtures.js';
import { eventually } from '../../support/wait.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';
import { recordingLog } from '../../support/log.js';

afterEach(cleanUp);

const D1 = 'aaaaaaaaaa1'; const D2 = 'aaaaaaaaaa2'; const D3 = 'aaaaaaaaaa3'; const D4 = 'aaaaaaaaaa4'; const D5 = 'aaaaaaaaaa5';
const X = 'bbbbbbbbbbX';
const docPath = (root: string, id: string) => path.join(root, `documents/youtube/${id}.md`);
const at = (n: number) => `2030-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
const files = (root: string) => new VaultFileWriter(root, PRODUCT_SOURCES);

async function items(root: string): Promise<Map<string, string>> {
  const states = await itemStates(PRODUCT_SOURCES, registeredSource(await registeredFiles(root, PRODUCT_SOURCES)));
  return new Map([...states].map(([key, state]) => [key, state.state === 'present' ? `present:${state.digest}` : `deleted:${state.at}`]));
}
async function deletionTimes(root: string): Promise<Record<string, string>> {
  const file = path.join(root, DELETIONS_FILE);
  if (!existsSync(file)) return {};
  return Object.fromEntries((JSON.parse(await readFile(file, 'utf8')).deleted as { sourceId: string; deletedAt: string }[])
    .map((record) => [record.sourceId, record.deletedAt]));
}

async function add(root: string, id: string, now?: string) {
  await new MarkdownVault(files(root), now ? { now: () => new Date(now) } : {}).add(transcriptDocument(video(id)));
}
async function modify(root: string, id: string, text: string, when: string) {
  const file = docPath(root, id);
  const [, front, body] = (await readFile(file, 'utf8')).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u)!;
  const metadata = parse(front!) as { collector: Record<string, unknown> };
  metadata.collector.updated_at = when;
  await writeFile(file, `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body!.trim()}\n${text}\n`);
}
async function setStatus(root: string, id: string, status: 'draft' | 'published', when: string) {
  await new Collector(new MarkdownVault(files(root), { now: () => new Date(when) }), undefined, { log: recordingLog() }).setStatus(`youtube:${id}`, status);
}
async function remove(root: string, id: string, when: string) {
  await new Collector(new MarkdownVault(files(root), { now: () => new Date(when) }), undefined, { log: recordingLog() }).delete(`youtube:${id}`);
}
const store = (root: string, when?: string) => new JsonSubscriptionStore(files(root), 'youtube', when ? () => new Date(when) : undefined);
const pauseCollection = (root: string) => new JsonScheduleStore(files(root)).save({ enabled: false });
const scheduleOn = async (root: string) => (await new JsonScheduleStore(files(root)).load()).enabled;
const counts = (documents: Partial<Record<'added' | 'updated' | 'removed', number>>, subscriptions: Partial<Record<'added' | 'updated' | 'removed', number>> = {}) => ({
  documents: { added: 0, updated: 0, removed: 0, ...documents }, subscriptions: { added: 0, updated: 0, removed: 0, ...subscriptions },
});

async function using<T>(at: Machine, use: (workspace: VaultWorkspace) => Promise<T>, overrides: OpenOverrides = {}): Promise<T> {
  const workspace = await open(at, overrides, false);
  try { return await use(workspace); } finally { await workspace.close(); }
}

async function exportFrom(at: Machine, name: string): Promise<string> {
  await mkdir(at.exports, { recursive: true });
  return using(at, async (workspace) => (await workspace.operations.exportTo(path.join(at.exports, `${name}.zip`))).result!.exportPath!);
}

const createNew = (at: Machine, packageFile: string) => importNewVault({ log: recordingLog(), sources: PRODUCT_SOURCES, packageFile, folder: at.vault, createdBy: 'XR Collector test' });

let base: { root: string; a: string; b: string };
beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-exchange-base-'));
  const a = await machine('A', root); const b = await machine('B', root);
  await seed(a.vault);
  for (const id of [D1, D2, D3, D4]) await add(a.vault, id);
  await store(a.vault).add(channel('UC456'));
  await createNew(b, await exportFrom(a, 'a-1'));
  base = { root, a: a.vault, b: b.vault };
});
afterAll(async () => { await rm(base.root, { recursive: true, force: true }); });

async function pair() {
  const root = await temp();
  const a = await machine('A', root); const b = await machine('B', root);
  await cp(base.a, a.vault, { recursive: true });
  await cp(base.b, b.vault, { recursive: true });
  return { root, a, b };
}

async function changeB(b: string) {
  await add(b, D5);
  await modify(b, D1, 'B 補充的段落', at(1));
  await remove(b, D2, at(1));
  await store(b, at(1)).add(channel('UC789'));
  await store(b, at(1)).update('UC123', { settings: { ...settings, intervalMinutes: 360 } });
  await store(b, at(1)).remove('UC456');
}
const changedCounts = counts({ added: 1, updated: 1, removed: 1 }, { added: 1, updated: 1, removed: 1 });

const workFolders = async (root: string) => (await readdir(root)).filter((name) => name.startsWith('.xr-collector-import-'));

async function documentState(root: string, id: string) {
  const deletedAt = (await deletionTimes(root))[id];
  if (existsSync(docPath(root, id))) {
    const document = await new MarkdownVault(files(root)).read(`youtube:${id}`);
    if (!document) return { kind: 'hidden', at: deletedAt };
    return { kind: 'present', body: await readFile(docPath(root, id), 'utf8'), status: document.status };
  }
  return deletedAt ? { kind: 'deleted', at: deletedAt } : { kind: 'absent' };
}
type Status = 'draft' | 'published';
const has = (text: string, status?: Status) => ({ kind: 'present', body: expect.stringContaining(text), ...(status ? { status } : {}) });
const lacks = (text: string, status?: Status) => ({ kind: 'present', body: expect.not.stringContaining(text), ...(status ? { status } : {}) });
const deleted = (when: string) => ({ kind: 'deleted', at: when });
const ABSENT = { kind: 'absent' };

const rowOf = async (root: string, id = 'UC123') => (JSON.parse(await readFile(path.join(root, 'settings/youtube-channels.json'), 'utf8')) as {
  channels: Array<Record<string, unknown>>;
}).channels.find((row) => row.id === id)!;
const progress = {
  lastCheckedAt: '2026-10-18T00:00:00.000Z',
  checkFailures: { count: 2, since: '2026-10-17T00:00:00.000Z', error: { code: 'network_error', message: '無法連線。' } },
  outOfRange: [{ videoId: D3, before: '2026-10-01T00:00:00.000Z' }],
  failures: [{ videoId: D4, title: '影片', attempts: 1, errorCode: 'network_error', failedAt: '2026-10-18T00:00:00.000Z', skipped: false }],
};
const autoPauseFailures = { count: 5, since: '2026-10-16T00:00:00.000Z', error: { code: 'network_error', message: '無法連線。' } };
const autoPause = (root: string, when: string) => store(root, when).update('UC123', { enabled: false, nextCheckAt: null, autoPausedAt: when, checkFailures: autoPauseFailures });

interface Rule {
  name: string;
  change: (a: string, b: string) => Promise<void>;
  preview: Partial<ImportPreview>;
  mode?: ImportMode;
  refused?: string;
  documents?: Record<string, object>;
  subscription?: Record<string, unknown>;
  subscriptionIds?: string[];
  removals?: [string, string][];
  collectionOn?: boolean;
  sameAsFile?: boolean;
}

async function check(rule: Rule) {
  const { a, b } = await pair();
  await rule.change(a.vault, b.vault);
  const incoming = await items(b.vault);
  const file = await exportFrom(b, 'b-1');
  const mode = rule.mode ?? 'merge';
  await using(a, async (workspace) => {
    const preview = await workspace.operations.previewImport(file);
    expect(preview).toMatchObject(rule.preview);
    if (rule.refused) {
      expect(() => workspace.operations.applyImport(preview.id, mode)).toThrow(expect.objectContaining({ message: rule.refused }));
      return;
    }
    workspace.operations.applyImport(preview.id, mode);
    await workspace.operations.finished();
    expect(workspace.operations.status()).toMatchObject({ state: 'completed', operation: 'import', result: { importMode: mode, imported: preview[mode] } });
  });
  if (rule.documents) {
    const actual = Object.fromEntries(await Promise.all(Object.keys(rule.documents).map(async (id) => [id, await documentState(a.vault, id)])));
    expect(actual).toMatchObject(rule.documents);
  }
  if (rule.subscription) {
    const row = await rowOf(a.vault);
    const entries = Object.entries(rule.subscription);
    expect(row).toMatchObject(Object.fromEntries(entries.filter(([, value]) => value !== undefined)));
    for (const [field] of entries.filter(([, value]) => value === undefined)) expect(row).not.toHaveProperty(field);
  }
  if (rule.subscriptionIds) expect((await store(a.vault).list()).map((row) => row.id).sort()).toEqual(rule.subscriptionIds);
  if (rule.removals) expect((await store(a.vault).removals()).map((record) => [record.id, record.removedAt])).toEqual(rule.removals);
  if (rule.collectionOn !== undefined) expect(await scheduleOn(a.vault)).toBe(rule.collectionOn);
  if (rule.sameAsFile) expect(await items(a.vault)).toEqual(incoming);
}

const DOCUMENT_RULES: Rule[] = [
  {
    name: 'A01 a deletion on B travels back to A in a merge',
    change: async (_a, b) => { await remove(b, D2, at(1)); },
    preview: { merge: counts({ removed: 1 }), replace: counts({ removed: 1 }), localNewer: 0, package: { fileName: 'b-1.zip', exportedAt: expect.any(String), machine: 'B' } },
    documents: { [D1]: has(''), [D2]: deleted(at(1)) },
  },
  {
    name: 'A01 a deletion on B travels back to A in a replace',
    change: async (_a, b) => { await remove(b, D2, at(1)); },
    preview: { replace: counts({ removed: 1 }) }, mode: 'replace',
    documents: { [D2]: deleted(at(1)) },
  },
  {
    name: 'A02 a merge keeps a document A added while B deleted another',
    change: async (a, b) => { await remove(b, D2, at(1)); await add(a, D5); },
    preview: { merge: counts({ removed: 1 }), replace: counts({ removed: 2 }), localNewer: 1 },
    documents: { [D2]: deleted(at(1)), [D5]: has('') },
  },
  {
    name: 'A02 a replace leaves only the file\'s documents, and a document only A had leaves without a record',
    change: async (a, b) => { await remove(b, D2, at(1)); await add(a, D5); },
    preview: { replace: counts({ removed: 2 }) }, mode: 'replace',
    documents: { [D2]: deleted(at(1)), [D5]: ABSENT },
  },
  {
    name: 'A03 the newer of two changes of a document wins, in both directions',
    change: async (a, b) => {
      await modify(a, D1, 'A 的段落', at(1)); await modify(b, D1, 'B 的段落', at(2));
      await modify(a, D3, 'A 較新的段落', at(3)); await modify(b, D3, 'B 較舊的段落', at(2));
    },
    preview: { merge: counts({ updated: 1 }), replace: counts({ updated: 2 }), localNewer: 1 },
    documents: { [D1]: has('B 的段落'), [D3]: has('A 較新的段落') },
  },
  {
    name: 'A04 the newer of a deletion and a change wins, in both directions',
    change: async (a, b) => {
      await modify(a, D1, 'A 在刪除之後修改', at(2)); await remove(b, D1, at(1));
      await modify(a, D3, 'A 在刪除之前修改', at(1)); await remove(b, D3, at(2));
      await remove(a, D4, at(1)); await modify(b, D4, 'B 在刪除之後修改', at(2));
      await remove(a, D2, at(2)); await modify(b, D2, 'B 在刪除之前修改', at(1));
    },
    preview: { merge: counts({ added: 1, removed: 1 }), localNewer: 2 },
    documents: { [D1]: has('A 在刪除之後修改'), [D3]: deleted(at(2)), [D4]: has('B 在刪除之後修改'), [D2]: deleted(at(2)) },
  },
  {
    name: 'A04 the newer of two deletion records is kept and counted as a removal; a replace counts both records it writes',
    change: async (a, b) => {
      await remove(a, D1, at(1)); await remove(b, D1, at(2));
      await remove(a, D3, at(2)); await remove(b, D3, at(1));
    },
    preview: { merge: counts({ removed: 1 }), replace: counts({ removed: 2 }), localNewer: 0 },
    documents: { [D1]: deleted(at(2)), [D3]: deleted(at(2)) },
  },
  {
    name: 'A05 changes made at the same time keep the local state, so a merge has nothing to import',
    change: async (a, b) => {
      await modify(a, D1, 'A 的段落', at(1)); await modify(b, D1, 'B 的段落', at(1));
      await modify(a, D3, 'A 的段落', at(1)); await remove(b, D3, at(1));
      await store(a, at(1)).update('UC123', { title: 'A 的名稱' }); await store(b, at(1)).update('UC123', { title: 'B 的名稱' });
    },
    preview: { merge: counts({}), replace: counts({ updated: 1, removed: 1 }, { updated: 1 }), localNewer: 3 },
    refused: '沒有需要匯入的內容。',
  },
  {
    name: '#217 a document takes the status and content of the side with the newer change, in both directions',
    change: async (a, b) => {
      await setStatus(a, D1, 'draft', at(2)); await modify(b, D1, 'B 較舊的段落', at(1));
      await setStatus(a, D3, 'draft', at(1)); await modify(b, D3, 'B 較新的段落', at(2));
      await modify(a, D4, 'A 較舊的段落', at(1)); await setStatus(b, D4, 'draft', at(2));
    },
    preview: { merge: counts({ updated: 2 }), localNewer: 1 },
    documents: { [D1]: lacks('B 較舊的段落', 'draft'), [D3]: has('B 較新的段落', 'published'), [D4]: lacks('A 較舊的段落', 'draft') },
  },
  {
    name: 'A06 the same video collected at different times is no change, so a replace has nothing to do',
    change: async (a, b) => { await add(a, 'samevideo01', '2026-10-01T00:00:00.000Z'); await add(b, 'samevideo01', '2026-10-05T00:00:00.000Z'); },
    preview: { merge: counts({}), replace: counts({}), localNewer: 0 }, mode: 'replace',
    refused: '本機內容已與匯入檔相同。',
  },
  {
    name: 'A09 deletion records of documents A never had come along as removals, so collection passes over the video',
    change: async (_a, b) => { await add(b, X); await remove(b, X, at(1)); await remove(b, D2, at(1)); },
    preview: { merge: counts({ removed: 2 }), replace: counts({ removed: 2 }), localNewer: 0 },
    documents: { [X]: deleted(at(1)), [D2]: deleted(at(1)) },
  },
  {
    name: 'A09 deletion records are written by a merge even when they are all the file brings, and both modes count them',
    change: async (_a, b) => { await add(b, X); await remove(b, X, at(1)); },
    preview: { merge: counts({ removed: 1 }), replace: counts({ removed: 1 }), localNewer: 0 },
    documents: { [X]: deleted(at(1)) },
  },
];

const SUBSCRIPTION_RULES: Rule[] = [
  {
    name: 'A08 subscriptions are added, updated and removed by the newer change, keeping local progress and the collection switch',
    change: async (a, b) => {
      await changeB(b);
      await store(a).update('UC123', { lastCheckedAt: '2026-10-18T00:00:00.000Z' });
      await store(a, at(1)).add(channel('UCAAA', { addedAt: at(1) }));
      await pauseCollection(b);
    },
    preview: { merge: changedCounts, localNewer: 1 },
    subscriptionIds: ['UC123', 'UC789', 'UCAAA'],
    subscription: { settings: { intervalMinutes: 360 }, lastCheckedAt: '2026-10-18T00:00:00.000Z', nextCheckAt: expect.any(String) },
    removals: [['UC456', at(1)]],
    collectionOn: true,
  },
  {
    name: 'A08 a subscription made again after the other side removed it is newer than the removal',
    change: async (a, b) => {
      await store(a, at(1)).remove('UC456'); await store(b, at(1)).remove('UC456');
      await store(b).add(channel('UC456', { addedAt: at(2) }));
    },
    preview: { merge: counts({}, { added: 1 }) },
    subscriptionIds: ['UC123', 'UC456'],
    removals: [],
  },
  {
    name: 'A08 a replace keeps the local progress and collection switch',
    change: async (a, b) => {
      await changeB(b);
      await store(a).update('UC123', { lastCheckedAt: progress.lastCheckedAt, checkFailures: progress.checkFailures });
      await pauseCollection(b);
    },
    preview: { replace: changedCounts }, mode: 'replace',
    subscription: { settings: { intervalMinutes: 360 }, lastCheckedAt: progress.lastCheckedAt, checkFailures: progress.checkFailures },
    subscriptionIds: ['UC123', 'UC789'],
    collectionOn: true,
    sameAsFile: true,
  },
  {
    name: '#291 a pause B made by itself does not travel in a merge, leaving A\'s subscription enabled',
    change: async (_a, b) => { await autoPause(b, at(1)); await add(b, D5); },
    preview: { merge: counts({ added: 1 }), localNewer: 0 },
    subscription: { enabled: true, autoPausedAt: undefined, checkFailures: undefined },
  },
  {
    name: '#291 a pause B made by itself does not travel in a replace either',
    change: async (_a, b) => { await autoPause(b, at(1)); await add(b, D5); },
    preview: {}, mode: 'replace',
    subscription: { enabled: true, autoPausedAt: undefined, checkFailures: undefined },
  },
  {
    name: '#291 a pause by the person on B travels by its newer change',
    change: async (_a, b) => { await store(b, at(1)).update('UC123', { enabled: false }); },
    preview: { merge: counts({}, { updated: 1 }) },
    subscription: { enabled: false, updatedAt: at(1) },
  },
  {
    name: '#291 a resume on A later than B\'s pause wins',
    change: async (a, b) => {
      await store(b, at(1)).update('UC123', { enabled: false });
      await store(a, at(1)).update('UC123', { enabled: false }); await store(a, at(2)).update('UC123', { enabled: true });
    },
    preview: { merge: counts({}), localNewer: 1 },
    refused: '沒有需要匯入的內容。',
    subscription: { enabled: true, updatedAt: at(2) },
  },
  {
    name: '#291 A\'s own automatic pause stays when the file brings a newer change by the person',
    change: async (a, b) => { await autoPause(a, at(1)); await store(b, at(2)).update('UC123', { settings: { ...settings, intervalMinutes: 360 } }); },
    preview: { merge: counts({}, { updated: 1 }) },
    subscription: { enabled: false, autoPausedAt: at(1), checkFailures: autoPauseFailures, settings: { intervalMinutes: 360 }, updatedAt: at(2) },
  },
  {
    name: 'S2 S4 newer settings come from the file while A keeps its own progress and never takes B\'s',
    change: async (a, b) => {
      await store(b, at(2)).update('UC123', { title: 'B 改的名稱', settings: { ...settings, intervalMinutes: 360 }, enabled: false });
      await store(b).update('UC123', { lastCheckedAt: at(3), outOfRange: [{ videoId: D5, before: at(3) }] });
      await store(a).update('UC123', progress);
    },
    preview: { merge: counts({}, { updated: 1 }), localNewer: 0 },
    subscription: { title: 'B 改的名稱', enabled: false, settings: { ...settings, intervalMinutes: 360 }, updatedAt: at(2), ...progress, nextCheckAt: null },
  },
  {
    name: 'S3 newer local settings and progress stay, so a merge has nothing to import',
    change: async (a, b) => {
      await store(b, at(1)).update('UC123', { settings: { ...settings, intervalMinutes: 360 } });
      await store(b).update('UC123', { lastCheckedAt: at(3) });
      await store(a, at(2)).update('UC123', { title: 'A 改的名稱', ...progress });
    },
    preview: { merge: counts({}), replace: counts({}, { updated: 1 }), localNewer: 1 },
    refused: '沒有需要匯入的內容。',
    subscription: { title: 'A 改的名稱', settings, ...progress },
  },
  {
    name: 'S4 a local subscription never checked takes no lastCheckedAt from the file',
    change: async (a, b) => {
      await store(b, at(1)).update('UC123', { title: 'B 改的名稱', lastCheckedAt: at(1) });
      const { lastCheckedAt: _lastCheckedAt, ...unchecked } = await rowOf(a);
      await writeFile(path.join(a, 'settings/youtube-channels.json'), `${JSON.stringify({ version: 3, channels: [unchecked, await rowOf(a, 'UC456')] }, null, 2)}\n`);
    },
    preview: { merge: counts({}, { updated: 1 }) },
    subscription: { title: 'B 改的名稱', lastCheckedAt: undefined },
  },
];

describe('merge and replace rules', () => {
  it.each(DOCUMENT_RULES)('documents: $name', check);
  it.each(SUBSCRIPTION_RULES)('subscriptions: $name', check);

  it('A07 joins Vaults that never exchanged, deciding shared items by time and removing nothing without a record', async () => {
    const root = await temp();
    const a = await machine('A', root); const c = await machine('C', root);
    await seed(a.vault); await add(a.vault, D1); await add(a.vault, 'aaaaaaaaaaA');
    await seed(c.vault); await add(c.vault, 'aaaaaaaaaaC');
    await store(c.vault, at(1)).update('UC123', { settings: { ...settings, intervalMinutes: 30 } });
    const file = await exportFrom(c, 'c-1');
    await using(a, async (workspace) => {
      expect((await importFile(workspace, file)).preview).toMatchObject({ merge: counts({ added: 1 }, { updated: 1 }), localNewer: 2 });
    });
    expect((await new MarkdownVault(files(a.vault)).list()).map((document) => document.sourceId).sort())
      .toEqual([D1, 'aaaaaaaaaaA', 'aaaaaaaaaaC', 'dQw4w9WgXcQ'].sort());
    expect((await rowOf(a.vault)).settings).toMatchObject({ intervalMinutes: 30 });
  });
});

describe('the export before an import (X77-A11)', () => {
  it('is written in a folder it creates and holds the Vault as it was before the import', async () => {
    const { a, b } = await pair();
    await changeB(b.vault);
    const file = await exportFrom(b, 'b-1');
    const before = await items(a.vault);
    const backup = await using(a, async (workspace) => (await importFile(workspace, file)).status.result!.backupPath!);
    expect(path.dirname(backup)).toBe(a.backups);
    expect(path.basename(backup)).toMatch(/^匯入前備份 \d{4}-\d{2}-\d{2} \d{6}\.zip$/u);
    const restored = await machine('restored', a.root);
    await createNew(restored, backup);
    expect(await items(restored.vault)).toEqual(before);
  });

  it('stops the import with the Vault unchanged when it cannot be written', async () => {
    const { a, b } = await pair();
    await changeB(b.vault);
    const file = await exportFrom(b, 'b-1');
    const blocked = path.join(a.root, 'blocked');
    await writeFile(blocked, 'a file where the backup folder should be');
    const before = await items(a.vault);
    await using(a, async (workspace) => {
      await importFile(workspace, file);
      expect(workspace.operations.status()).toMatchObject({ state: 'error', operation: 'import', result: null });
      expect(() => workspace.operations.enterWrite()()).not.toThrow();
    }, { backupFolder: path.join(blocked, 'backups') });
    expect(await items(a.vault)).toEqual(before);
    expect(await workFolders(a.vault)).toEqual([]);
  });
});

describe('an import that fails while it applies (X77-A12)', () => {
  async function prepared() {
    const shared = await pair();
    await changeB(shared.b.vault);
    const file = await exportFrom(shared.b, 'b-1');
    return { ...shared, file, before: await items(shared.a.vault), after: await items(shared.b.vault) };
  }

  it('checks every file again when it applies, leaving the Vault unchanged when the export file changed after the comparison', async () => {
    const { a, file, before } = await prepared();
    await using(a, async (workspace) => {
      const preview = await workspace.operations.previewImport(file);
      const entry = `documents/youtube/${D5}.md`;
      const damaged = Buffer.from((await zipEntries(await readFile(file))).get(entry)!);
      damaged[damaged.length - 2] = damaged[damaged.length - 2]! ^ 1;
      await writeFile(file, await tampered(await readFile(file), entry, damaged));
      workspace.operations.applyImport(preview.id, 'merge'); await workspace.operations.finished();
      expect(workspace.operations.status()).toMatchObject({ state: 'error', operation: 'import', errorCode: 'invalid_request', result: null });
      expect(await workFolders(a.vault)).toEqual([]);
    });
    expect(await items(a.vault)).toEqual(before);
  });

  it('reports a partial import and its backup when putting files in place fails; importing again or replacing with the backup completes', async () => {
    const { a, file, before, after } = await prepared();
    const place = VaultFileWriter.prototype.place;
    let placed = 0;
    const failing = vi.spyOn(VaultFileWriter.prototype, 'place').mockImplementation(async function (this: VaultFileWriter, ...args) {
      placed += 1;
      if (placed === 2) throw new Error('disk stopped');
      return place.apply(this, args);
    });
    await using(a, async (workspace) => {
      await importFile(workspace, file);
      failing.mockRestore();
      const status = workspace.operations.status();
      expect(status).toMatchObject({ state: 'error', operation: 'import', result: { importMode: 'merge', partiallyApplied: true, backupPath: expect.any(String) } });
      expect(await workFolders(a.vault)).toEqual([]);
      const partial = await items(a.vault);
      expect(partial).not.toEqual(before);
      expect(partial).not.toEqual(after);

      await importFile(workspace, file);
      expect(await items(a.vault)).toEqual(after);
      await importFile(workspace, status.result!.backupPath!, 'replace');
      expect(workspace.operations.status().state).toBe('completed');
    });
    expect(await items(a.vault)).toEqual(before);
  });
});

it('starts no new collection step while an import applies, then goes on, and a queued check of a subscription the import removed writes nothing back (X77-A12)', async () => {
  const { a, b } = await pair();
  await changeB(b.vault);
  const file = await exportFrom(b, 'b-1');
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const listed: string[] = [];
  await using(a, async (workspace) => {
    const preview = await workspace.operations.previewImport(file);
    const runs = await workspace.subscriptions.of('youtube')!.startRun({ trigger: 'manual', subscriptionIds: ['UC123', 'UC456'] });
    await eventually(() => expect(listed).toEqual(['UC123']));
    workspace.operations.applyImport(preview.id, 'merge');
    expect(workspace.operations.status().state).toBe('waiting');
    release();
    await workspace.operations.finished();
    expect(workspace.operations.status().state).toBe('completed');
    await Promise.all(runs.map((run) => workspace.jobs.whenSettled(run.job.id)));
    expect(listed).toEqual(['UC123']);
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
  expect((await store(a.vault).list()).map((row) => row.id).sort()).toEqual(['UC123', 'UC789']);
});

describe('creating a Vault from an export file (X77-A15)', () => {
  it('gives the new Vault its own ID, the export\'s content and the export\'s collection switch', async () => {
    const { a, b } = await pair();
    expect(await readVaultId(b.vault)).not.toBe(await readVaultId(a.vault));
    expect((await readdir(b.vault)).sort()).toEqual([VAULT_MARKER, 'documents', 'settings'].sort());
    expect(await scheduleOn(b.vault)).toBe(true);
    expect(await items(b.vault)).toEqual(await items(a.vault));

    await pauseCollection(a.vault);
    const c = await machine('C', a.root);
    await createNew(c, await exportFrom(a, 'a-paused'));
    expect(await scheduleOn(c.vault)).toBe(false);
  });

  it('refuses an invalid file or an existing folder, leaving the location as it was', async () => {
    const { root, a } = await pair();
    const good = await exportFrom(a, 'a-2');
    const empty = path.join(root, 'Empty');
    await mkdir(empty); await writeFile(path.join(empty, '.DS_Store'), '');
    const full = path.join(root, 'Full');
    await mkdir(full); await writeFile(path.join(full, 'note.txt'), 'mine');
    const bad = await fileOf(root, 'bad.zip', await tampered(await readFile(good), `documents/youtube/${D1}.md`, 'changed'));
    const fresh = path.join(root, 'New');
    for (const [packageFile, folder, message] of [
      [bad, fresh, '不一致'], [path.join(root, 'old.xr-vault'), fresh, '.zip'], [path.join(root, 'none.zip'), fresh, '找不到'],
      [good, full, '已經有「Full」'], [good, empty, '已經有「Empty」'], [good, path.join(root, 'missing', 'New'), '找不到新知識庫所在的資料夾'],
      [good, 'relative', '完整路徑'],
    ] as const) {
      await expect(importNewVault({ log: recordingLog(), sources: PRODUCT_SOURCES, createdBy: 'XR Collector test', packageFile, folder }), `${packageFile} → ${folder}`)
        .rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
    }
    expect(await readdir(empty)).toEqual(['.DS_Store']);
    expect(await readdir(full)).toEqual(['note.txt']);
    expect(existsSync(fresh)).toBe(false);
    expect((await readdir(root)).filter((name) => name.includes('.importing-'))).toEqual([]);
  });
});

describe('an export', () => {
  it('only reads the Vault and names the Vault and machine the file came from', async () => {
    const { a } = await pair();
    const listing = async () => (await readdir(a.vault, { recursive: true })).sort();
    const before = await listing();
    const file = await exportFrom(a, 'a-2');
    expect(await listing()).toEqual(before);
    expect((await manifestOf(await readFile(file))).source).toEqual({ vaultId: await readVaultId(a.vault), machine: 'A', folderName: path.basename(a.vault) });
  });

  it('creates the export folder for the suggested file but no other missing folder, and never replaces a file unasked', async () => {
    const { a } = await pair();
    await using(a, async (workspace) => {
      const suggested = workspace.operations.exportSuggestion().path;
      expect(existsSync(a.exports)).toBe(false);
      await expect(workspace.operations.exportTo(suggested)).resolves.toMatchObject({ state: 'completed', result: { exportPath: suggested } });
      for (const [file, error] of [
        [path.join(a.root, 'no-such-folder', 'export.zip'), { code: 'invalid_request', message: '匯出檔所在的資料夾不存在。' }],
        [path.join(a.exports, 'x.xr-vault'), { code: 'invalid_request', message: '匯出檔名必須以 .zip 結尾。' }],
        [suggested, { code: 'file_exists' }],
      ] as const) {
        await expect(workspace.operations.exportTo(file), file).rejects.toMatchObject(error);
      }
      expect(existsSync(path.join(a.root, 'no-such-folder'))).toBe(false);
    });
  });
});

it('updates real Meilisearch with what an import wrote and removed, and keeps it after restart', { tags: [REAL_ENGINE_TAG] }, async () => {
  const { a, b } = await pair();
  await changeB(b.vault);
  await modify(b.vault, D3, '匯入後的珊瑚觀察', at(2));
  const file = await exportFrom(b, 'b-1');
  const real = { searchBinary: bundledMeilisearch, searchLexicon: bundledLexicon, createSearch: undefined };
  const ids = async (workspace: VaultWorkspace, query: string) => (await workspace.search.search({ query })).hits.map((hit) => hit.id);
  await using(a, async (workspace) => {
    await eventually(() => expect(workspace.search.status().state).toBe('ready'));
    expect(await ids(workspace, `${D2}`)).toContain(`youtube:${D2}`);
    await importFile(workspace, file);
    expect(workspace.operations.status().state).toBe('completed');
    await eventually(async () => expect(await ids(workspace, '珊瑚觀察')).toEqual([`youtube:${D3}`]));
    await eventually(async () => expect(await ids(workspace, `${D5} 的字幕`)).toContain(`youtube:${D5}`));
    await eventually(async () => expect(await ids(workspace, `${D2} 的字幕`)).not.toContain(`youtube:${D2}`));
  }, real);
  await using(a, async (workspace) => {
    await eventually(() => expect(workspace.search.status().state).toBe('ready'));
    expect(await ids(workspace, '珊瑚觀察')).toEqual([`youtube:${D3}`]);
  }, real);
});

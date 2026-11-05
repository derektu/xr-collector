import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector } from '../../src/core/collector.js';
import { registerSourceDefinitions, scheduleFile } from '../../src/core/source-registry.js';
import type { SubscriptionRecord } from '../../src/core/types.js';
import type { CapturedDocument } from '../../src/plugins/types.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { JsonScheduleStore } from '../../src/subscriptions/schedule-store.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { DELETIONS_FILE, deletionsToJson, type DeletionRecord } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { createVaultDirectory, inspectVaultDirectory, VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { VaultFileWriter } from '../../src/vault/vault-files.js';
import { applyInPlace, finishInPlaceImports, importNewVault } from '../../src/vault/vault-import.js';
import { IMPORT_STAGING_PREFIX, openPackage, packageFormatVersion, writePackage, type PackageReader } from '../../src/vault/vault-package.js';
import { FAKE, FAKE_DEFAULTS, fakeDefinition } from '../support/fake-source-plugin.js';

// A source type declares the Vault format and the package format its files need. `newer` needs
// version 2 of both; YouTube and `fake` need version 1. A Vault whose marker is older than a file
// in it is a Vault an older program opens and misreads, so every kind of Vault file raises the
// marker before it is written, whichever way it is written.

const NEWER = fakeDefinition('newer', 'newer-net', { vault: 2, package: 2 });
registerSourceDefinitions([FAKE, NEWER]);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-format-'));
  roots.push(root);
  return root;
}

async function vault(): Promise<string> {
  return createVaultDirectory(path.join(await temp(), 'vault'), 'XR Collector test');
}

const marker = async (root: string) => JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8')) as Record<string, unknown>;

const document = (type: string, key: string): CapturedDocument => ({
  sourceType: type, key, sourceUrl: `https://${type}.example/item/${key}`, title: `${type} ${key}`, publisher: { id: null, name: '作者' },
  publishedAt: null, bodyMarkdown: '內容。', details: { rating: 3, note: null },
});
const feed = (type: string, id: string): SubscriptionRecord => ({
  id, title: `動態 ${id}`, url: `https://${type}.example/feed/${id}`, enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
  settings: FAKE_DEFAULTS, nextCheckAt: null, lastDispatchedAt: null,
});
const deletion = (type: string, key: string): Omit<DeletionRecord, 'deletedAt'> => ({
  sourceType: type, sourceId: key, sourceUrl: `https://${type}.example/item/${key}`, title: `${type} ${key}`,
  publisherId: null, publisherName: '作者',
});
const deletionsBytes = (record: Omit<DeletionRecord, 'deletedAt'>) =>
  Buffer.from(`${JSON.stringify(deletionsToJson([{ ...record, deletedAt: '2026-09-18T00:00:00.000Z' }]), null, 2)}\n`);
/** The text of a document file, as a Vault of its own writes it. */
async function documentText(type: string, key: string): Promise<string> {
  const source = await vault();
  await new MarkdownVault(new VaultFileWriter(source)).add(document(type, key));
  return readFile(path.join(source, 'documents', type, `${key}.md`), 'utf8');
}
/** The export file of an in-place import whose changes all carry their own bytes. */
const noReader = {} as PackageReader;
const transcript = transcriptDocument({
  videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '影片', channelId: 'UC123',
  channelTitle: '頻道', publishedAt: null, languageCode: 'zh-TW', languageName: null, subtitleKind: 'manual', bodyMarkdown: '字幕。',
});

describe('the Vault format a source type needs', () => {
  it('leaves the marker as it is while only types of the base format write', async () => {
    const root = await vault();
    const before = await readFile(path.join(root, VAULT_MARKER));
    await new MarkdownVault(new VaultFileWriter(root)).add(transcript);
    await new MarkdownVault(new VaultFileWriter(root)).add(document('fake', 'one-1'));
    await new JsonSubscriptionStore(new VaultFileWriter(root), 'fake').add(feed('fake', 'news'));
    expect(await readFile(path.join(root, VAULT_MARKER))).toEqual(before);
  });

  it('raises the marker on the first write of the type\'s documents, keeping the rest of the marker', async () => {
    const root = await vault();
    const before = await marker(root);
    expect(before.formatVersion).toBe(1);
    await new MarkdownVault(new VaultFileWriter(root)).add(document('newer', 'one-1'));
    expect(await marker(root)).toEqual({ ...before, formatVersion: 2 });
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'existing', documentCount: 1 });
  });

  it('raises the marker on the first write of the type\'s subscription file', async () => {
    const root = await vault();
    await new JsonSubscriptionStore(new VaultFileWriter(root), 'newer').add(feed('newer', 'news'));
    expect((await marker(root)).formatVersion).toBe(2);
  });

  it('raises the marker when the deletion file first holds a record of the type', async () => {
    const root = await vault();
    const files = new VaultFileWriter(root);
    // An item still capturing has no document, so its deletion record is the first file of its type.
    await new Collector(new MarkdownVault(files)).recordDeletion(deletion('newer', 'one-1'));
    expect((await marker(root)).formatVersion).toBe(2);
  });

  it('leaves the marker as it is for the schedule file and deletion records of base types', async () => {
    const root = await vault();
    const before = await readFile(path.join(root, VAULT_MARKER));
    await new JsonScheduleStore(new VaultFileWriter(root)).save({ enabled: false });
    await new Collector(new MarkdownVault(new VaultFileWriter(root))).recordDeletion(deletion('fake', 'one-1'));
    expect(await readFile(path.join(root, scheduleFile()), 'utf8')).toContain('"enabled": false');
    expect(await readFile(path.join(root, VAULT_MARKER))).toEqual(before);
  });

  it('raises the marker before an in-place import puts the type\'s files in place', async () => {
    const root = await vault();
    const changes = new Map([
      ['documents/newer/one-1.md', { bytes: Buffer.from(await documentText('newer', 'one-1')) }],
    ]);
    await applyInPlace(root, noReader, changes, () => undefined);
    expect((await marker(root)).formatVersion).toBe(2);
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'existing', documentCount: 1 });
  });

  it('raises the marker before an in-place import puts a deletion file holding the type\'s records', async () => {
    const root = await vault();
    const changes = new Map([[DELETIONS_FILE, { bytes: deletionsBytes(deletion('newer', 'one-1')) }]]);
    await applyInPlace(root, noReader, changes, () => undefined);
    expect((await marker(root)).formatVersion).toBe(2);
  });

  it('raises the marker for every file of an in-place import before the first file is put in place', async () => {
    // A stop after the first rename leaves the rest to the next open; a program that does not know the
    // type would drop that journal as invalid, so the marker has to keep such a program out already.
    const root = await vault();
    const changes = new Map([
      ['documents/fake/one-1.md', { bytes: Buffer.from(await documentText('fake', 'one-1')) }],
      ['documents/newer/two-2.md', { bytes: Buffer.from(await documentText('newer', 'two-2')) }],
    ]);
    const stop = new Error('stopped');
    await expect(applyInPlace(root, noReader, changes, () => undefined, (phase, count) => {
      if (phase === 'renaming' && count === 1) throw stop;
    })).rejects.toBe(stop);
    expect((await marker(root)).formatVersion).toBe(2);
    expect(await finishInPlaceImports(root)).toBe(true);
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'existing', documentCount: 2 });
  });

  it('raises the marker before the next open puts any file of an interrupted import in place', async () => {
    const root = await vault();
    const work = path.join(root, `${IMPORT_STAGING_PREFIX}${randomUUID()}`);
    await mkdir(path.join(work, 'files'), { recursive: true });
    await writeFile(path.join(work, 'files', '0'), await documentText('fake', 'one-1'));
    await writeFile(path.join(work, 'files', '1'), deletionsBytes(deletion('newer', 'two-2')));
    await writeFile(path.join(work, 'journal.json'), JSON.stringify({ version: 1, entries: [
      { path: 'documents/fake/one-1.md', staged: 'files/0' }, { path: DELETIONS_FILE, staged: 'files/1' },
    ] }));
    // The first file cannot be put in place, so whatever the marker holds was written before any rename.
    await mkdir(path.join(root, 'documents', 'fake', 'one-1.md', 'in-the-way'), { recursive: true });
    await expect(finishInPlaceImports(root)).rejects.toThrow();
    expect((await marker(root)).formatVersion).toBe(2);
  });

  it('raises the marker of a Vault created from an export file whose only file of the type is a deletion record', async () => {
    const root = await vault();
    const exports = await temp();
    const files = new VaultFileWriter(root);
    await new MarkdownVault(files).add(document('newer', 'one-1'));
    await new Collector(new MarkdownVault(files)).delete('newer:one-1');
    const file = path.join(exports, 'deleted.zip');
    await writePackage(root, file);
    const reader = await openPackage(file);
    expect(reader.paths()).toEqual([DELETIONS_FILE]);
    reader.close();

    const profile = path.join(exports, 'profile');
    await mkdir(profile);
    const created = await importNewVault({ packageFile: file, folder: path.join(exports, 'imported'), profilePath: profile, createdBy: 'XR Collector test' });
    expect((await marker(created)).formatVersion).toBe(2);
  });

  it('does not open a Vault of a version no registered type declares', async () => {
    const root = await vault();
    await writeFile(path.join(root, VAULT_MARKER), JSON.stringify({ ...await marker(root), formatVersion: 3 }));
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'invalid' });
  });
});

describe('the way into a Vault\'s files', () => {
  it('refuses a path that names no Vault file and writes nothing', async () => {
    const root = await vault();
    const files = new VaultFileWriter(root);
    await expect(files.writeJson('settings/tags.json', {})).rejects.toThrow('Not a Vault file: settings/tags.json');
    await expect(files.create('notes/one.md', 'text')).rejects.toThrow('Not a Vault file: notes/one.md');
    await expect(files.remove(VAULT_MARKER)).rejects.toThrow(`Not a Vault file: ${VAULT_MARKER}`);
    await expect(access(path.join(root, 'settings', 'tags.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, VAULT_MARKER))).resolves.toBeUndefined();
  });
});

describe('the package format a source type needs', () => {
  it('writes a package with the highest version among the types whose files it holds', () => {
    expect(packageFormatVersion(['documents/youtube/dQw4w9WgXcQ.md', 'documents/fake/one-1.md', 'settings/fake-feeds.json'])).toBe(1);
    expect(packageFormatVersion(['documents/youtube/dQw4w9WgXcQ.md', 'documents/newer/one-1.md'])).toBe(2);
    expect(packageFormatVersion(['settings/newer-feeds.json'])).toBe(2);
    expect(packageFormatVersion([])).toBe(1);
  });

  it('exports at version 1 without the type\'s files and at version 2 with them, and imports either', async () => {
    const root = await vault();
    const exports = await temp();
    await new MarkdownVault(new VaultFileWriter(root)).add(transcript);
    await new MarkdownVault(new VaultFileWriter(root)).add(document('fake', 'one-1'));
    const base = path.join(exports, 'base.zip');
    await writePackage(root, base);
    const baseReader = await openPackage(base);
    expect(baseReader.manifest.formatVersion).toBe(1);
    baseReader.close();

    await new MarkdownVault(new VaultFileWriter(root)).add(document('newer', 'two-2'));
    const raised = path.join(exports, 'raised.zip');
    await writePackage(root, raised);
    const raisedReader = await openPackage(raised);
    expect(raisedReader.manifest.formatVersion).toBe(2);
    raisedReader.close();

    const profile = path.join(exports, 'profile');
    await mkdir(profile);
    const created = await importNewVault({ packageFile: raised, folder: path.join(exports, 'imported'), profilePath: profile, createdBy: 'XR Collector test' });
    expect((await marker(created)).formatVersion).toBe(2);
    expect((await new MarkdownVault(new VaultFileWriter(created)).list()).map((entry) => entry.id).sort()).toEqual(['fake:one-1', 'newer:two-2', 'youtube:dQw4w9WgXcQ']);
  });
});

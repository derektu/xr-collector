import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Collector } from '../../src/core/collector.js';
import type { SourceDefinition } from '../../src/core/source-contract.js';
import type { SourceRegistry } from '../../src/core/source-registry.js';
import type { DeletionRecord } from '../../src/core/document-types.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { SOURCE_DEFINITIONS } from '../../src/plugins/index.js';
import { JsonScheduleStore } from '../../src/subscriptions/schedule-store.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { createVaultDirectory, inspectVaultDirectory, VAULT_MARKER, vaultFormatVersion } from '../../src/vault/vault-directory.js';
import { VaultFileWriter } from '../../src/vault/vault-files.js';
import { applyInPlace, finishInPlaceImports, importNewVault } from '../../src/vault/vault-import.js';
import { IMPORT_STAGING_PREFIX, openPackage, packageFormatVersion, writePackage, type PackageReader } from '../../src/vault/vault-package.js';
import { fakeDefinition } from '../support/fake-source-plugin.js';
import { PRODUCT_SOURCES, productSourcesWith } from '../support/product-sources.js';

// The Vault and package format versions are the program's: the highest each registered source type
// declares. The program writes every Vault and package at them, whatever the files hold, and opens
// none above them; a Vault an older program opens never holds files that program misreads.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-format-'));
  roots.push(root);
  return root;
}

const marker = async (root: string) => JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8')) as Record<string, unknown>;

/** A Vault of `sources` whose marker an earlier program wrote, at format version 1. */
async function versionOneVault(sources: SourceRegistry = PRODUCT_SOURCES): Promise<string> {
  const root = await createVaultDirectory(path.join(await temp(), 'vault'), 'XR Collector test', sources);
  await writeFile(path.join(root, VAULT_MARKER), `${JSON.stringify({ ...await marker(root), formatVersion: 1 }, null, 2)}\n`);
  return root;
}

const transcript = (videoId: string) => transcriptDocument({
  videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: '影片', channelId: 'UC123',
  channelTitle: '頻道', publishedAt: null, languageCode: 'zh-TW', languageName: null, subtitleKind: 'manual', bodyMarkdown: '字幕。',
});
const rssDeletion: Omit<DeletionRecord, 'deletedAt'> = {
  sourceType: 'rss', sourceId: '0123456789abcdef', sourceUrl: 'https://blog.example/posts/1', title: '文章',
  publisherId: null, publisherName: '部落格',
};
/** The text of a transcript document file, as a Vault of its own writes it. */
async function transcriptText(videoId: string): Promise<string> {
  const source = await createVaultDirectory(path.join(await temp(), 'vault'), 'XR Collector test', PRODUCT_SOURCES);
  await new MarkdownVault(new VaultFileWriter(source, PRODUCT_SOURCES)).add(transcript(videoId));
  return readFile(path.join(source, 'documents', 'youtube', `${videoId}.md`), 'utf8');
}
/** The export file of an in-place import whose changes all carry their own bytes. */
const noReader = {} as PackageReader;

/**
 * Why the format versions of `definitions` let a type be added below an existing one: every type
 * declares a Vault and a package version of its own, together 1 to the number of types, so the
 * next type has to declare one above all of them.
 */
function formatVersionProblems(definitions: readonly SourceDefinition[]): string[] {
  const expected = definitions.map((_, index) => index + 1);
  return (['vaultFormatVersion', 'packageFormatVersion'] as const).flatMap((field) => {
    const declared = definitions.map((definition) => definition[field]).sort((a, b) => a - b);
    return declared.every((version, index) => version === expected[index])
      ? []
      : [`${field}: ${definitions.map((definition) => `${definition.id} ${definition[field]}`).join(', ')}`];
  });
}

describe('the format versions of the product\'s source types', () => {
  it('give every type a version above the types before it', () => {
    expect(formatVersionProblems(SOURCE_DEFINITIONS)).toEqual([]);
    expect(vaultFormatVersion(PRODUCT_SOURCES)).toBe(SOURCE_DEFINITIONS.length);
    expect(packageFormatVersion(PRODUCT_SOURCES)).toBe(SOURCE_DEFINITIONS.length);
  });

  it('refuse a new type that declares a version no higher than an existing type', () => {
    const added = (vault: number, pkg: number) => [...SOURCE_DEFINITIONS, fakeDefinition('later', 'later-net', { vault, package: pkg })];
    expect(formatVersionProblems(added(3, 3))).toEqual([]);
    expect(formatVersionProblems(added(2, 3))).toEqual([expect.stringMatching(/^vaultFormatVersion: .*later 2/u)]);
    expect(formatVersionProblems(added(3, 1))).toEqual([expect.stringMatching(/^packageFormatVersion: .*later 1/u)]);
  });

  it('are the program\'s versions: the highest the registered types declare', () => {
    const sources = productSourcesWith(fakeDefinition('later', 'later-net', { vault: 3, package: 4 }));
    expect(vaultFormatVersion(sources)).toBe(3);
    expect(packageFormatVersion(sources)).toBe(4);
  });
});

describe('the Vault format version', () => {
  it('is the one a new Vault is created at', async () => {
    const root = await createVaultDirectory(path.join(await temp(), 'vault'), 'XR Collector test', PRODUCT_SOURCES);
    expect((await marker(root)).formatVersion).toBe(2);
  });

  it('is the one an older Vault\'s marker is raised to on its first write, whatever the file, keeping the rest of the marker', async () => {
    const root = await versionOneVault();
    const before = await marker(root);
    await new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES)).add(transcript('dQw4w9WgXcQ'));
    expect(await marker(root)).toEqual({ ...before, formatVersion: 2 });
    expect(await inspectVaultDirectory(root, PRODUCT_SOURCES)).toMatchObject({ kind: 'existing', documentCount: 1 });

    const scheduled = await versionOneVault();
    await new JsonScheduleStore(new VaultFileWriter(scheduled, PRODUCT_SOURCES)).save({ enabled: false });
    expect((await marker(scheduled)).formatVersion).toBe(2);
  });

  it('leaves the marker of an older Vault as it is while the Vault is only read', async () => {
    const root = await versionOneVault();
    const before = await readFile(path.join(root, VAULT_MARKER));
    expect(await inspectVaultDirectory(root, PRODUCT_SOURCES)).toMatchObject({ kind: 'existing' });
    expect(await new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES)).list()).toEqual([]);
    await writePackage(root, PRODUCT_SOURCES, path.join(await temp(), 'read.zip'));
    expect(await readFile(path.join(root, VAULT_MARKER))).toEqual(before);
  });

  it('is the one an in-place import raises an older marker to before its first file is put in place', async () => {
    // A stop after the first rename leaves the rest to the next open, so the marker has to keep an
    // older program out already.
    const root = await versionOneVault();
    const changes = new Map([
      ['documents/youtube/dQw4w9WgXcQ.md', { bytes: Buffer.from(await transcriptText('dQw4w9WgXcQ')) }],
      ['documents/youtube/aaaaaaaaaaa.md', { bytes: Buffer.from(await transcriptText('aaaaaaaaaaa')) }],
    ]);
    const stop = new Error('stopped');
    await expect(applyInPlace(root, PRODUCT_SOURCES, noReader, changes, () => undefined, (phase, count) => {
      if (phase === 'renaming' && count === 1) throw stop;
    })).rejects.toBe(stop);
    expect((await marker(root)).formatVersion).toBe(2);
    expect(await finishInPlaceImports(root, PRODUCT_SOURCES)).toBe(true);
    expect(await inspectVaultDirectory(root, PRODUCT_SOURCES)).toMatchObject({ kind: 'existing', documentCount: 2 });
  });

  it('is the one the next open raises an older marker to before it puts any file of an interrupted import in place', async () => {
    const root = await versionOneVault();
    const work = path.join(root, `${IMPORT_STAGING_PREFIX}${randomUUID()}`);
    await mkdir(path.join(work, 'files'), { recursive: true });
    await writeFile(path.join(work, 'files', '0'), await transcriptText('dQw4w9WgXcQ'));
    await writeFile(path.join(work, 'journal.json'), JSON.stringify({ version: 1, entries: [
      { path: 'documents/youtube/dQw4w9WgXcQ.md', staged: 'files/0' },
    ] }));
    // The file cannot be put in place, so whatever the marker holds was written before any rename.
    await mkdir(path.join(root, 'documents', 'youtube', 'dQw4w9WgXcQ.md', 'in-the-way'), { recursive: true });
    await expect(finishInPlaceImports(root, PRODUCT_SOURCES)).rejects.toThrow();
    expect((await marker(root)).formatVersion).toBe(2);
  });

  it('is the one a Vault created from an export file is written at', async () => {
    const root = await versionOneVault();
    await new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES)).add(transcript('dQw4w9WgXcQ'));
    const exports = await temp();
    const file = path.join(exports, 'youtube.zip');
    await writePackage(root, PRODUCT_SOURCES, file);
    const profile = path.join(exports, 'profile');
    await mkdir(profile);
    const created = await importNewVault({ sources: PRODUCT_SOURCES, packageFile: file, folder: path.join(exports, 'imported'), profilePath: profile, createdBy: 'XR Collector test' });
    expect((await marker(created)).formatVersion).toBe(2);
  });

  it('bounds the Vaults the program opens', async () => {
    const root = await versionOneVault();
    await writeFile(path.join(root, VAULT_MARKER), JSON.stringify({ ...await marker(root), formatVersion: 3 }));
    expect(await inspectVaultDirectory(root, PRODUCT_SOURCES)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('較新版本') });
  });
});

describe('the package format version', () => {
  async function exported(fill: (files: VaultFileWriter) => Promise<void>): Promise<string> {
    const root = await createVaultDirectory(path.join(await temp(), 'vault'), 'XR Collector test', PRODUCT_SOURCES);
    await fill(new VaultFileWriter(root, PRODUCT_SOURCES));
    const file = path.join(await temp(), 'export.zip');
    await writePackage(root, PRODUCT_SOURCES, file);
    return file;
  }

  it('is the one every export is written at, whatever the files it holds', async () => {
    const youtube = await exported(async (files) => { await new MarkdownVault(files).add(transcript('dQw4w9WgXcQ')); });
    const deletionOnly = await exported(async (files) => { await new Collector(new MarkdownVault(files)).recordDeletion(rssDeletion); });
    const empty = await exported(async () => undefined);
    for (const [file, paths] of [[youtube, ['documents/youtube/dQw4w9WgXcQ.md']], [deletionOnly, [DELETIONS_FILE]], [empty, []]] as const) {
      const reader = await openPackage(file, PRODUCT_SOURCES);
      expect(reader.paths()).toEqual(paths);
      expect(reader.manifest.formatVersion).toBe(2);
      reader.close();
    }
  });

  it('bounds the export files the program reads', async () => {
    const sources = productSourcesWith(fakeDefinition('later', 'later-net', { vault: 3, package: 3 }));
    const root = await createVaultDirectory(path.join(await temp(), 'vault'), 'XR Collector test', sources);
    const newer = path.join(await temp(), 'newer.zip');
    await writePackage(root, sources, newer);
    (await openPackage(newer, sources)).close();
    await expect(openPackage(newer, PRODUCT_SOURCES)).rejects.toThrow('不支援這個匯出檔的格式版本。');
  });
});

describe('the way into a Vault\'s files', () => {
  it('refuses a path that names no Vault file and writes nothing', async () => {
    const root = await versionOneVault();
    const before = await readFile(path.join(root, VAULT_MARKER));
    const files = new VaultFileWriter(root, PRODUCT_SOURCES);
    await expect(files.writeJson('settings/tags.json', {})).rejects.toThrow('Not a Vault file: settings/tags.json');
    await expect(files.create('notes/one.md', 'text')).rejects.toThrow('Not a Vault file: notes/one.md');
    await expect(files.remove(VAULT_MARKER)).rejects.toThrow(`Not a Vault file: ${VAULT_MARKER}`);
    await expect(access(path.join(root, 'settings', 'tags.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, VAULT_MARKER))).toEqual(before);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSourceDefinitions } from '../../src/core/source-registry.js';
import type { SubscriptionRecord } from '../../src/core/types.js';
import type { CapturedDocument } from '../../src/plugins/types.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { createVaultDirectory, inspectVaultDirectory, VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { importNewVault } from '../../src/vault/vault-import.js';
import { openPackage, packageFormatVersion, writePackage } from '../../src/vault/vault-package.js';
import { FAKE, FAKE_DEFAULTS, fakeDefinition } from '../support/fake-source-plugin.js';

// A source type declares the Vault format and the package format its files need. `newer` needs
// version 2 of both; YouTube and `fake` need version 1.

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
const transcript = transcriptDocument({
  videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '影片', channelId: 'UC123',
  channelTitle: '頻道', publishedAt: null, languageCode: 'zh-TW', languageName: null, subtitleKind: 'manual', bodyMarkdown: '字幕。',
});

describe('the Vault format a source type needs', () => {
  it('leaves the marker as it is while only types of the base format write', async () => {
    const root = await vault();
    const before = await readFile(path.join(root, VAULT_MARKER));
    await new MarkdownVault(root).add(transcript);
    await new MarkdownVault(root).add(document('fake', 'one-1'));
    await new JsonSubscriptionStore(root, 'fake').add(feed('fake', 'news'));
    expect(await readFile(path.join(root, VAULT_MARKER))).toEqual(before);
  });

  it('raises the marker on the first write of the type\'s documents, keeping the rest of the marker', async () => {
    const root = await vault();
    const before = await marker(root);
    expect(before.formatVersion).toBe(1);
    await new MarkdownVault(root).add(document('newer', 'one-1'));
    expect(await marker(root)).toEqual({ ...before, formatVersion: 2 });
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'existing', documentCount: 1 });
  });

  it('raises the marker on the first write of the type\'s subscription file', async () => {
    const root = await vault();
    await new JsonSubscriptionStore(root, 'newer').add(feed('newer', 'news'));
    expect((await marker(root)).formatVersion).toBe(2);
  });

  it('does not open a Vault of a version no registered type declares', async () => {
    const root = await vault();
    await writeFile(path.join(root, VAULT_MARKER), JSON.stringify({ ...await marker(root), formatVersion: 3 }));
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'invalid' });
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
    await new MarkdownVault(root).add(transcript);
    await new MarkdownVault(root).add(document('fake', 'one-1'));
    const base = path.join(exports, 'base.zip');
    await writePackage(root, base);
    const baseReader = await openPackage(base);
    expect(baseReader.manifest.formatVersion).toBe(1);
    baseReader.close();

    await new MarkdownVault(root).add(document('newer', 'two-2'));
    const raised = path.join(exports, 'raised.zip');
    await writePackage(root, raised);
    const raisedReader = await openPackage(raised);
    expect(raisedReader.manifest.formatVersion).toBe(2);
    raisedReader.close();

    const profile = path.join(exports, 'profile');
    await mkdir(profile);
    const created = await importNewVault({ packageFile: raised, folder: path.join(exports, 'imported'), profilePath: profile, createdBy: 'XR Collector test' });
    expect((await marker(created)).formatVersion).toBe(2);
    expect((await new MarkdownVault(created).list()).map((entry) => entry.id).sort()).toEqual(['fake:one-1', 'newer:two-2', 'youtube:dQw4w9WgXcQ']);
  });
});

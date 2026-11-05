// The export file a Vault is carried in: a zip of only the Vault's registered files with a manifest
// of sizes and SHA-256, refused whole when corrupt or not the current format, disk space checked
// before an import, and an export that fails cleanly when a file vanishes or cannot be read, so a
// user never moves a partial or damaged Vault to another machine.
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { JsonScheduleStore } from '../../src/subscriptions/schedule-store.js';
import { JsonSubscriptionStore } from '../../src/subscriptions/subscription-store.js';
import { Collector } from '../../src/core/collector.js';
import type { SavedDocument, TranscriptSearch } from '../../src/core/types.js';
import { createHttpApp } from '../../src/server/app.js';
import { DELETIONS_FILE } from '../../src/vault/deleted-documents.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { inspectVaultDirectory, VAULT_MARKER } from '../../src/vault/vault-directory.js';
import { MANIFEST, registeredFiles, writePackage } from '../../src/vault/vault-package.js';
import { VaultSelection } from '../../src/vault/vault-selection.js';
import { exportFileName } from '../../src/vault/transfer-files.js';
import { importNewVault } from '../../src/vault/vault-import.js';
import { VaultWorkspace } from '../../src/vault/workspace.js';
import {
  ensureMarker, manifestOf, packageBytes, packageFiles, packageOf, sha, tampered, unpackBytes, withPackage, zipEntries, zipOf,
} from '../support/package-fixtures.js';
import type { CapturedTranscript } from '../../src/plugins/youtube/adapter.js';
import { withYouTube, type YouTubeTestSources } from '../support/youtube-sources.js';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { VaultFileWriter } from '../../src/vault/vault-files.js';

/** Runs before the export opens a file for reading, so a test can change the file at that moment. */
const reads = vi.hoisted(() => ({ before: undefined as undefined | ((file: string) => void) }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const createReadStream = ((file: string, ...rest: unknown[]) => {
    reads.before?.(String(file));
    return (actual.createReadStream as (...values: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.createReadStream;
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});

const roots: string[] = [];
const workspaces: VaultWorkspace[] = [];
afterEach(async () => {
  reads.before = undefined;
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-package-test-'));
  roots.push(root);
  return root;
}
const capture: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: '資料包測試', channelId: 'UC123', channelTitle: '測試頻道', publishedAt: null,
  languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual', bodyMarkdown: '森林觀測資料。'.repeat(200),
};
const settings = { intervalMinutes: 60, backfillDays: 30, backfillMaxItems: 10 };
const deletedId = 'gone0000001';
async function seed(root: string) {
  const vault = new MarkdownVault(new VaultFileWriter(root));
  await vault.add(transcriptDocument(capture));
  await vault.add(transcriptDocument({ ...capture, videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', title: '第二份' }));
  await vault.add(transcriptDocument({ ...capture, videoId: deletedId, sourceUrl: `https://www.youtube.com/watch?v=${deletedId}`, title: '已刪除' }));
  await new Collector(vault).delete(`youtube:${deletedId}`);
  await new JsonSubscriptionStore(new VaultFileWriter(root), 'youtube').add({
    id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z',
    settings, nextCheckAt: null, lastDispatchedAt: null, outOfRange: [{ videoId: 'old00000001', before: '2026-09-01T00:00:00.000Z' }],
  });
  await new JsonScheduleStore(new VaultFileWriter(root)).save({ enabled: true });
}
const REGISTERED = [
  'documents/youtube/abcdefghijk.md', 'documents/youtube/dQw4w9WgXcQ.md',
  'settings/deleted-documents.json', 'settings/youtube-channels.json', 'settings/youtube-schedule.json',
];
/** Files a person keeps in the Vault folder, none of which the Vault records. */
async function addPersonalFiles(root: string): Promise<number> {
  const files: [string, string | Buffer][] = [
    ['documents/youtube/notes.md', '# 我自己的筆記'], ['documents/youtube/README.txt', 'read me'],
    ['documents/youtube/short.md', '---\nnot: a document\n---\n'],
    ['.obsidian/app.json', '{}'], ['筆記/x.md', '筆記'], ['attachments/a.png', Buffer.from([0, 1, 2])],
    ['versions/old.md', 'old'], ['management/list.json', '[]'], ['settings/other.json', '{}'],
  ];
  for (const [file, data] of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), data);
  }
  await symlink(path.join(root, '筆記'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, '.DS_Store'), '');
  return files.length + 1;
}
function fakeSearch(root: string): TranscriptSearch {
  let docs: SavedDocument[] = [];
  return {
    status: () => ({ state: 'ready', indexedDocuments: docs.length }),
    async index(doc) { docs.push(doc); },
    async remove(id) { docs = docs.filter((doc) => doc.id !== id); },
    async rebuild() {
      const vault = new MarkdownVault(new VaultFileWriter(root));
      docs = (await Promise.all((await vault.list()).map(({ id }) => vault.read(id)))).filter((doc): doc is SavedDocument => !!doc);
    },
    async search() { return { hits: [], total: 0, offset: 0, limit: 50 }; },
  };
}
async function open(root: string, overrides: Partial<Parameters<typeof VaultWorkspace.open>[0]> & YouTubeTestSources = {}) {
  await ensureMarker(root);
  const workspace = await VaultWorkspace.open(withYouTube({
    root, selection: new VaultSelection(`${root}.selection.json`), profilePath: `${root}.profile`, createdBy: 'XR Collector test',
    capture: { capture: async () => capture },
    channelSource: { resolve: async () => ({ id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123' }), listVideos: async () => [] },
    searchBinary: '', searchData: `${root}-search`, exportFolder: `${root}.exports`, backupFolder: `${root}.backups`,
    createSearch: async (destination) => ({ search: fakeSearch(destination), close: async () => undefined }),
    ...overrides,
  }));
  workspaces.push(workspace);
  return workspace;
}
describe('package format (PKG-01)', () => {
  it('is a zip of the registered files at their Vault paths, compressed, with a manifest of sizes and digests', async () => {
    const root = path.join(await temp(), 'Vault'); await seed(root);
    const bytes = await packageBytes(root, { createdBy: 'XR Collector test', exportedAt: new Date('2026-10-18T00:00:00.000Z') });
    const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true });
    const entries: yauzl.Entry[] = [];
    for await (const entry of zip.eachEntry()) entries.push(entry);
    zip.close();
    expect(entries.map((entry) => entry.fileName).sort()).toEqual([...REGISTERED, MANIFEST].sort());
    expect(entries.every((entry) => entry.compressionMethod === 8)).toBe(true);
    const document = entries.find((entry) => entry.fileName === 'documents/youtube/dQw4w9WgXcQ.md')!;
    expect(document.compressedSize).toBeLessThan(document.uncompressedSize / 5);

    const manifest = await manifestOf(bytes);
    expect(manifest).toMatchObject({
      format: 'xr-collector-package', formatVersion: 1, exportedAt: '2026-10-18T00:00:00.000Z', createdBy: 'XR Collector test',
      summary: { documents: 2, subscriptions: 1, deletions: 1 },
    });
    const files = await packageFiles(bytes);
    expect(manifest.files.map((row) => row.path).sort()).toEqual(REGISTERED);
    for (const row of manifest.files) {
      expect(row).toEqual({ path: row.path, size: files.get(row.path)!.length, sha256: sha(files.get(row.path)!) });
      if (row.path !== DELETIONS_FILE) expect(files.get(row.path)).toEqual(await readFile(path.join(root, row.path)));
    }
    expect(JSON.parse(files.get('settings/youtube-channels.json')!.toString()).channels[0].outOfRange).toEqual([{ videoId: 'old00000001', before: '2026-09-01T00:00:00.000Z' }]);
  });
});

describe('registered files only (PKG-02)', () => {
  it('leaves files the Vault does not record out of the package, counts them and never fails on them', async () => {
    const at = await temp(); const root = path.join(at, 'Vault'); await seed(root);
    await ensureMarker(root);
    const personal = await addPersonalFiles(root);
    await mkdir(path.join(root, 'locked'));
    await writeFile(path.join(root, 'locked', 'secret.txt'), 'x');
    const registered = await registeredFiles(root);
    expect(registered.files.map((file) => file.path).sort()).toEqual(REGISTERED);
    expect(registered.unregisteredFiles).toBe(personal + 1);

    const workspace = await open(root);
    expect((await workspace.collector.list()).map((document) => document.sourceId).sort()).toEqual(['abcdefghijk', 'dQw4w9WgXcQ']);
    const file = path.join(at, 'export.zip');
    const status = await workspace.exportTo(file);
    expect(status).toMatchObject({ state: 'completed', result: { exportPath: file, unregisteredFiles: personal + 1 } });
    expect(status.message).toContain(`${personal + 1} 個不屬於知識庫的檔案`);
    expect([...(await packageFiles(await readFile(file))).keys()].sort()).toEqual(REGISTERED);
    const again = await workspace.exportTo(path.join(at, 'again.zip'));
    expect(again.result?.unregisteredFiles).toBe(personal + 1);
    expect([...(await packageFiles(await readFile(path.join(at, 'again.zip')))).keys()].sort()).toEqual(REGISTERED);
  });

  it('reports no others for a Vault holding only its own files', async () => {
    const root = path.join(await temp(), 'Vault'); await seed(root); await ensureMarker(root);
    expect((await registeredFiles(root)).unregisteredFiles).toBe(0);
  });

  it('fails the listing and the export on a document file of the Vault that cannot be read, naming it', async () => {
    const root = path.join(await temp(), 'Vault'); await seed(root);
    await writeFile(path.join(root, 'documents/youtube/abcdefghijk.md'), 'no frontmatter');
    await expect(new MarkdownVault(new VaultFileWriter(root)).list()).rejects.toMatchObject({ file: 'documents/youtube/abcdefghijk.md' });
    await expect(registeredFiles(root)).rejects.toMatchObject({ code: 'vault_invalid', message: expect.stringContaining('documents/youtube/abcdefghijk.md') });
    // A document whose ID differs from its file name is no document of that name.
    await writeFile(path.join(root, 'documents/youtube/abcdefghijk.md'), (await readFile(path.join(root, 'documents/youtube/dQw4w9WgXcQ.md'), 'utf8')));
    await expect(registeredFiles(root)).rejects.toMatchObject({ message: expect.stringContaining('documents/youtube/abcdefghijk.md') });
  });
});

describe('refusing packages (PKG-03)', () => {
  async function good() {
    const root = path.join(await temp(), 'Vault'); await seed(root);
    return packageBytes(root);
  }
  async function refused(bytes: Buffer, message: string) {
    const target = path.join(await temp(), 'target');
    await expect(unpackBytes(bytes, target)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
    expect(existsSync(target)).toBe(false);
  }

  it('refuses a package whose files do not match its manifest', async () => {
    const bytes = await good();
    const manifest = await manifestOf(bytes);
    const files = [...(await packageFiles(bytes))].map(([file, data]) => ({ path: file, data }));
    await refused(await tampered(bytes, 'documents/youtube/dQw4w9WgXcQ.md', 'changed'), '不一致');
    const document = (await packageFiles(bytes)).get('documents/youtube/dQw4w9WgXcQ.md')!;
    const sameSize = Buffer.from(document); sameSize[sameSize.length - 2] ^= 1;
    await refused(await tampered(bytes, 'documents/youtube/dQw4w9WgXcQ.md', sameSize), '不一致');
    await refused(await packageOf(files.slice(1), { files: manifest.files }), '缺少');
    await refused(await packageOf(files, {}, [{ name: 'extra.txt', data: 'x' }]), '沒有列出');
    await refused(await packageOf(files, { files: manifest.files.map((row) => ({ ...row, size: row.size + 1 })) }), '不一致');
  });

  it('refuses an entry that unpacks larger than the manifest says', async () => {
    const huge = Buffer.alloc(4 * 1024 * 1024, 'a');
    const bytes = await zipOf([
      { name: 'settings/youtube-schedule.json', data: huge },
      { name: MANIFEST, data: JSON.stringify({ format: 'xr-collector-package', formatVersion: 1, files: [{ path: 'settings/youtube-schedule.json', size: 10, sha256: sha(huge) }] }) },
    ]);
    await refused(bytes, '不一致');
  });

  it.each([
    ['../outside.md', '不安全'], ['/absolute.md', '不安全'], ['documents\\youtube\\dQw4w9WgXcQ.md', '路徑'],
    ['attachments/a.png', '不支援的路徑'], ['settings/credentials.json', '不支援的路徑'], ['documents/web/dQw4w9WgXcQ.md', '不支援的路徑'],
  ])('refuses the path %s', async (file, message) => {
    await refused(await packageOf([{ path: file, data: 'x' }]), message);
  });

  it('refuses duplicate and case-folded paths, old JSON packages, files that are no zip and unknown versions', async () => {
    await refused(await zipOf([{ name: 'settings/youtube-schedule.json', data: '{}' }, { name: 'settings/YouTube-schedule.json', data: '{}' }, { name: MANIFEST, data: '{}' }]), '大小寫');
    await refused(Buffer.from(JSON.stringify({ format: 'xr-collector-vault', version: 3, files: [] })), 'zip');
    await refused(Buffer.from('not a package'), 'zip');
    await refused(await packageOf([], { formatVersion: 3 }), '格式版本');
    await refused(await packageOf([], { format: 'xr-collector-vault' }), '不是 XR Collector');
    await refused(await zipOf([{ name: 'documents/youtube/dQw4w9WgXcQ.md', data: 'x' }]), 'manifest.json');
  });

  it('refuses a file over 64 MiB before reading it', async () => {
    await refused(await packageOf([{ path: 'settings/youtube-schedule.json', data: '{}' }], {
      files: [{ path: 'settings/youtube-schedule.json', size: 64 * 1024 * 1024 + 1, sha256: sha('{}') }],
    }), '64 MiB');
  });

  it('opens a package with a row for each file and checks every read', async () => {
    const bytes = await good();
    await withPackage(bytes, async (reader) => {
      expect(reader.paths().sort()).toEqual(REGISTERED);
      expect((await reader.read('settings/youtube-schedule.json')).toString()).toContain('"enabled": true');
    });
  });
});

describe('disk space (PKG-04)', () => {
  it('refuses an import that does not fit on the disk, leaving the target as it was', async () => {
    const at = await temp(); const root = path.join(at, 'Vault'); await seed(root);
    const file = path.join(at, 'small.zip');
    await writeFile(file, await packageBytes(root));
    await expect(importNewVault({
      packageFile: file, folder: path.join(at, 'Imported'), profilePath: `${root}.profile`, createdBy: 'test',
      statfs: async () => ({ bavail: 1, bsize: 4096 }),
    })).rejects.toMatchObject({ code: 'insufficient_space' });
    expect(existsSync(path.join(at, 'Imported'))).toBe(false);
  });
});

describe('files that fail while an export reads them', () => {
  async function documentFile(root: string, id: string, body: string) {
    const template = await readFile(path.join(root, `documents/youtube/${capture.videoId}.md`), 'utf8');
    await writeFile(path.join(root, `documents/youtube/${id}.md`), template.replaceAll(capture.videoId, id).replace(/\n\n[\s\S]*$/u, `\n\n${body}\n`));
  }
  const leftovers = async (folder: string) => (await readdir(folder)).filter((name) => name.includes('.zip'));

  it('answers an export holding a document over 64 MiB with an error naming it and leaves no file', async () => {
    const at = await temp(); const root = path.join(at, 'Vault'); await seed(root);
    await documentFile(root, 'huge0000001', 'x'.repeat(65 * 1024 * 1024));
    const workspace = await open(root);
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test-token' });
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/vault/export', headers: { authorization: 'Bearer test-token' }, payload: { path: path.join(at, 'out.zip') },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain('documents/youtube/huge0000001.md');
      expect(await leftovers(at)).toEqual([]);
      expect(workspace.status().state).toBe('error');
    } finally { await app.close(); }
  });

  it('fails an export whose document disappears while it is written, naming the file and leaving none', async () => {
    const at = await temp(); const root = path.join(at, 'Vault');
    const vault = new MarkdownVault(new VaultFileWriter(root));
    await vault.add(transcriptDocument(capture));
    await vault.add(transcriptDocument({ ...capture, videoId: 'vanish00001', sourceUrl: 'https://www.youtube.com/watch?v=vanish00001' }));
    const vanishing = path.join(root, 'documents/youtube/vanish00001.md');
    // Listed before the export starts, the file goes once the export has opened its zip and comes to read it.
    reads.before = (file) => { if (file === vanishing) rmSync(file); };
    const workspace = await open(root);
    await expect(workspace.exportTo(path.join(at, 'out.zip'))).rejects.toThrow('documents/youtube/vanish00001.md');
    expect(existsSync(vanishing)).toBe(false);
    expect(await leftovers(at)).toEqual([]);
  });
});

describe('document files that cannot be read', () => {
  it('fails listings over HTTP with the path of the file', async () => {
    const at = await temp(); const root = path.join(at, 'Vault'); await seed(root);
    const workspace = await open(root);
    await writeFile(path.join(root, 'documents/youtube/broken00001.md'), 'not a document');
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace });
    try {
      for (const url of ['/api/documents', '/api/search/status']) {
        const response = await app.inject({ url });
        expect(response.statusCode).toBe(422);
        expect(response.json().error).toMatchObject({ code: 'vault_invalid', message: expect.stringContaining('documents/youtube/broken00001.md') });
      }
    } finally { await app.close(); }
  });
});

describe('local paths only over HTTP (PKG-05)', () => {
  it('writes an export without a path into the export folder and takes no package bodies', async () => {
    const at = await temp(); const root = path.join(at, 'Vault'); await seed(root);
    const workspace = await open(root);
    const app = await createHttpApp({ collector: workspace.collector, transfer: workspace, agentToken: 'test-token' });
    const headers = { authorization: 'Bearer test-token' };
    try {
      const suggestion = (await app.inject({ url: '/api/vault/export/suggestion', headers })).json();
      expect(suggestion).toEqual({ folder: `${root}.exports`, path: path.join(`${root}.exports`, exportFileName(new Date())) });
      const exported = await app.inject({ method: 'POST', url: '/api/vault/export', headers });
      expect(exported.statusCode).toBe(200);
      expect(exported.json()).toMatchObject({ state: 'completed', result: { exportPath: suggestion.path } });
      expect([...(await packageFiles(await readFile(suggestion.path))).keys()].sort()).toEqual(REGISTERED);
      expect((await app.inject({ method: 'POST', url: '/api/vault/export', headers })).json()).toMatchObject({ error: { code: 'file_exists' } });

      const body = { ...headers, 'content-type': 'application/octet-stream' };
      const bytes = await readFile(suggestion.path);
      for (const url of ['/api/vault/import/preview', '/api/vault/export']) {
        expect((await app.inject({ method: 'POST', url, headers: body, payload: bytes })).statusCode).toBe(415);
      }
      for (const url of ['/api/vault/restore', '/api/vault/restore/suggestion', '/api/vault/merge/preview', '/api/vault/merge/apply', '/api/vault/merge/cancel']) {
        expect((await app.inject({ method: url.endsWith('suggestion') ? 'GET' : 'POST', url, headers, payload: {} })).statusCode, url).toBe(404);
      }
    } finally { await app.close(); }
  });
});

describe('Vaults of an earlier format (CMP-01)', () => {
  it('refuses a Vault whose subscription or schedule file is not the current version, without changing it', async () => {
    const root = path.join(await temp(), 'Vault'); await seed(root); await ensureMarker(root);
    const channels = path.join(root, 'settings/youtube-channels.json');
    const original = await readFile(channels);
    await writeFile(channels, JSON.stringify([{ id: 'UC123', title: '頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-01-01' }]));
    const before = await readFile(channels);
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('youtube-channels.json') });
    expect(await readFile(channels)).toEqual(before);
    await writeFile(channels, original);
    await writeFile(path.join(root, 'settings/youtube-schedule.json'), JSON.stringify({ version: 1, enabled: true, intervalMinutes: 60 }));
    expect(await inspectVaultDirectory(root)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('youtube-schedule.json') });
    expect(JSON.parse(await readFile(path.join(root, VAULT_MARKER), 'utf8'))).toHaveProperty('id');
  });

  it('writes the export taken before an import as a package of the same format, naming the Vault and machine it came from', async () => {
    const at = await temp(); const local = path.join(at, 'Local'); const incoming = path.join(at, 'Incoming');
    await seed(local); await seed(incoming);
    await new MarkdownVault(new VaultFileWriter(incoming)).add(transcriptDocument({ ...capture, videoId: 'new00000001', sourceUrl: 'https://www.youtube.com/watch?v=new00000001' }));
    const workspace = await open(local);
    const file = path.join(at, 'incoming.zip');
    await writeFile(file, await packageBytes(incoming));
    const preview = await workspace.previewImport(file);
    expect(preview.merge.documents.added).toBe(1);
    workspace.applyImport(preview.id, 'merge'); await workspace.operationFinished();
    const backup = workspace.status().result!.backupPath!;
    expect(path.dirname(backup)).toBe(`${local}.backups`);
    expect(path.basename(backup)).toMatch(/^匯入前備份 \d{4}-\d{2}-\d{2} \d{6}\.zip$/u);
    const manifest = await manifestOf(await readFile(backup));
    expect(manifest).toMatchObject({ format: 'xr-collector-package', source: { machine: expect.any(String) } });
    expect(manifest).not.toHaveProperty('sync');
    expect([...(await zipEntries(await readFile(backup))).keys()]).not.toContain('documents/youtube/new00000001.md');
    expect(createHash('sha256').update(await readFile(path.join(local, 'documents/youtube/new00000001.md'))).digest('hex'))
      .toBe(createHash('sha256').update(await readFile(path.join(incoming, 'documents/youtube/new00000001.md'))).digest('hex'));
  });
});

it('never writes over an existing file', async () => {
  const root = path.join(await temp(), 'Vault'); await seed(root);
  const file = path.join(root, '..', 'exists.zip');
  await writeFile(file, 'keep');
  await expect(writePackage(root, file)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(file, 'utf8')).toBe('keep');
});

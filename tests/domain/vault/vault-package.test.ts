import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { JsonScheduleStore } from '../../../src/domain/subscriptions/schedule-store.js';
import { JsonSubscriptionStore } from '../../../src/domain/subscriptions/subscription-store.js';
import { Collector } from '../../../src/domain/vault/collector.js';
import { DELETIONS_FILE } from '../../../src/domain/vault/deleted-documents.js';
import { MarkdownVault } from '../../../src/domain/vault/markdown-vault.js';
import { FORMAT_VERSION } from '../../../src/domain/vault/vault-directory.js';
import { MANIFEST, registeredFiles, writePackage } from '../../../src/domain/vault/vault-package.js';
import {
  ensureMarker, manifestOf, packageBytes, packageFiles, packageOf, sha, tampered, unpackBytes, zipOf,
} from '../../support/package-fixtures.js';
import type { CapturedTranscript } from '../../../src/domain/sources/youtube/adapter.js';
import { transcriptDocument } from '../../../src/domain/sources/youtube/server.js';
import { VaultFileWriter } from '../../../src/domain/vault/vault-files.js';
import { PRODUCT_SOURCES } from '../../support/product-sources.js';

const roots: string[] = [];
afterEach(async () => {
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
  const vault = new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES));
  await vault.add(transcriptDocument(capture));
  await vault.add(transcriptDocument({ ...capture, videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', title: '第二份' }));
  await vault.add(transcriptDocument({ ...capture, videoId: deletedId, sourceUrl: `https://www.youtube.com/watch?v=${deletedId}`, title: '已刪除' }));
  await new Collector(vault).delete(`youtube:${deletedId}`);
  await new JsonSubscriptionStore(new VaultFileWriter(root, PRODUCT_SOURCES), 'youtube').add({
    id: 'UC123', title: '測試頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
    settings, nextCheckAt: null, lastDispatchedAt: null, outOfRange: [{ videoId: 'old00000001', before: '2026-09-01T00:00:00.000Z' }],
  });
  await new JsonScheduleStore(new VaultFileWriter(root, PRODUCT_SOURCES)).save({ enabled: true });
}
const REGISTERED = [
  'documents/youtube/abcdefghijk.md', 'documents/youtube/dQw4w9WgXcQ.md',
  'settings/deleted-documents.json', 'settings/youtube-channels.json', 'settings/youtube-schedule.json',
];
/** Files a person keeps in the Vault folder, none of which the Vault records. */
async function addPersonalFiles(root: string): Promise<void> {
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
}
const DOCUMENT = 'documents/youtube/dQw4w9WgXcQ.md';
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
  it('leaves files the Vault does not record out of the package and never fails on them', async () => {
    const at = await temp(); const root = path.join(at, 'Vault'); await seed(root);
    await ensureMarker(root);
    await addPersonalFiles(root);
    const registered = await registeredFiles(root, PRODUCT_SOURCES);
    expect(registered.files.map((file) => file.path).sort()).toEqual(REGISTERED);

    expect([...(await packageFiles(await packageBytes(root))).keys()].sort()).toEqual(REGISTERED);
  });
});

describe('refusing packages (PKG-03)', () => {
  let good: Buffer;
  let markdown: string;
  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-package-good-'));
    try {
      await seed(path.join(root, 'Vault'));
      good = await packageBytes(path.join(root, 'Vault'));
      markdown = (await packageFiles(good)).get(DOCUMENT)!.toString();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const goodFiles = async () => [...(await packageFiles(good))].map(([file, data]) => ({ path: file, data }));
  const deletion = { sourceType: 'youtube', sourceId: deletedId, sourceUrl: `https://www.youtube.com/watch?v=${deletedId}`, title: '已刪除', publisherId: 'UC123', publisherName: '測試頻道', deletedAt: '2026-10-15T00:00:00.000Z' };
  const oldChannels = JSON.stringify([{ id: 'UC123', title: '頻道', url: 'https://www.youtube.com/channel/UC123', enabled: true, addedAt: '2026-01-01T00:00:00.000Z' }]);

  it.each<[string, () => Promise<Buffer>, string]>([
    ['a file whose content differs from the manifest', async () => tampered(good, DOCUMENT, 'changed'), '不一致'],
    ['a file changed without changing its size', async () => {
      const same = Buffer.from(markdown); same[same.length - 2] = same[same.length - 2]! ^ 1;
      return tampered(good, DOCUMENT, same);
    }, '不一致'],
    ['a manifest whose size differs from the file', async () => packageOf(await goodFiles(), { files: (await manifestOf(good)).files.map((row) => ({ ...row, size: row.size + 1 })) }), '不一致'],
    ['a file the manifest lists but the zip lacks', async () => packageOf((await goodFiles()).slice(1), { files: (await manifestOf(good)).files }), '缺少'],
    ['a zip entry the manifest does not list', async () => packageOf(await goodFiles(), {}, [{ name: 'extra.txt', data: 'x' }]), '沒有列出'],
    ['a path that leaves the Vault', async () => packageOf([{ path: '../outside.md', data: 'x' }]), '不安全'],
    ['an absolute path', async () => packageOf([{ path: '/absolute.md', data: 'x' }]), '不安全'],
    ['a path with backslashes', async () => packageOf([{ path: 'documents\\youtube\\dQw4w9WgXcQ.md', data: 'x' }]), '路徑'],
    ['a file the Vault does not register', async () => packageOf([{ path: 'attachments/a.png', data: 'x' }]), '不支援的路徑'],
    ['a settings file the Vault does not register', async () => packageOf([{ path: 'settings/credentials.json', data: 'x' }]), '不支援的路徑'],
    ['a document of an unknown source type', async () => packageOf([{ path: 'documents/web/dQw4w9WgXcQ.md', data: 'x' }]), '不支援的路徑'],
    ['a file that is no zip', async () => Buffer.from('not a package'), 'zip'],
    ['a zip without a manifest', async () => zipOf([{ name: DOCUMENT, data: 'x' }]), 'manifest.json'],
    ['a newer package format version', async () => packageOf([], { formatVersion: FORMAT_VERSION + 1 }), '格式版本'],
    ['a package of another format', async () => packageOf([], { format: 'xr-collector-vault' }), '不是 XR Collector'],
    ['a document whose metadata is not a document', async () => packageOf([{ path: DOCUMENT, data: 'bad metadata' }]), '格式無效'],
    ['a document of a type the source does not have', async () => packageOf([{ path: DOCUMENT, data: markdown.replace('type: Transcript', 'type: Article') }]), '格式無效'],
    ['a subscription file of an earlier version', async () => packageOf([{ path: 'settings/youtube-channels.json', data: oldChannels }]), '訂閱或排程設定格式無效'],
    ['a malformed subscription file', async () => packageOf([{ path: 'settings/youtube-channels.json', data: '{}' }]), '訂閱或排程設定格式無效'],
    ['a schedule file of an earlier version', async () => packageOf([{ path: 'settings/youtube-schedule.json', data: JSON.stringify({ version: 1, enabled: true, intervalMinutes: 60 }) }]), '訂閱或排程設定格式無效'],
    ['a malformed deletion record', async () => packageOf([{ path: DELETIONS_FILE, data: JSON.stringify({ version: 1, deleted: [{ ...deletion, sourceId: 'short' }] }) }]), '刪除紀錄'],
    ['an unknown deletions version', async () => packageOf([{ path: DELETIONS_FILE, data: JSON.stringify({ version: 9, deleted: [] }) }]), '刪除紀錄'],
    ['a document together with its own deletion record', async () => packageOf([
      { path: DOCUMENT, data: markdown },
      { path: DELETIONS_FILE, data: JSON.stringify({ version: 1, deleted: [{ ...deletion, sourceId: capture.videoId, sourceUrl: capture.sourceUrl }] }) },
    ]), '同時有內容與刪除紀錄'],
  ])('refuses %s before writing anything', async (_name, bytes, message) => {
    const target = path.join(await temp(), 'target');
    await expect(unpackBytes(await bytes(), target)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
    expect(existsSync(target)).toBe(false);
  });
});

it('refuses an existing file and leaves it untouched, since a failed export removes only a file it created', async () => {
  const root = path.join(await temp(), 'Vault'); await seed(root);
  const file = path.join(root, '..', 'exists.zip');
  await writeFile(file, 'keep');
  await expect(writePackage(root, PRODUCT_SOURCES, file)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(file, 'utf8')).toBe('keep');
});

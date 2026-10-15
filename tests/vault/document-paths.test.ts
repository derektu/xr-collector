import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentId, documentIdFromPath, documentKeyFromId, documentKeyFromPath, documentPath, documentPathFromId,
} from '../../src/vault/document-paths.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { safePath } from '../../src/vault/vault-package.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('document paths', () => {
  it('converts between document IDs and Vault paths', () => {
    const key = { sourceType: 'youtube' as const, sourceId: 'dQw4w9WgXcQ' };
    expect(documentId(key)).toBe('youtube:dQw4w9WgXcQ');
    expect(documentPath(key)).toBe('documents/youtube/dQw4w9WgXcQ.md');
    expect(documentKeyFromPath('documents/youtube/dQw4w9WgXcQ.md')).toEqual(key);
    expect(documentKeyFromId('youtube:dQw4w9WgXcQ')).toEqual(key);
    expect(documentIdFromPath('documents/youtube/dQw4w9WgXcQ.md')).toBe('youtube:dQw4w9WgXcQ');
    expect(documentPathFromId('youtube:dQw4w9WgXcQ')).toBe('documents/youtube/dQw4w9WgXcQ.md');
  });

  it('refuses unknown source types and source IDs outside their rule', () => {
    for (const file of ['documents/web/dQw4w9WgXcQ.md', 'documents/youtube/short.md', 'documents/youtube/dQw4w9WgXcQ.txt',
      'documents/youtube/nested/dQw4w9WgXcQ.md', 'documents/dQw4w9WgXcQ.md', 'attachments/youtube/dQw4w9WgXcQ.md']) {
      expect(documentKeyFromPath(file), file).toBeNull();
    }
    for (const id of ['web:dQw4w9WgXcQ', 'youtube:short', 'dQw4w9WgXcQ', 'youtube:dQw4w9WgXcQ:x']) {
      expect(documentKeyFromId(id), id).toBeNull();
    }
    expect(safePath('documents/youtube/dQw4w9WgXcQ.md')).toBe(true);
    expect(safePath('documents/web/dQw4w9WgXcQ.md')).toBe(false);
    expect(safePath('settings/future.json')).toBe(false);
  });

  it('names the same file the Vault writes a document to', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-paths-')); roots.push(root);
    const saved = await new MarkdownVault(root).add({
      videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '路徑', channelId: 'UC1',
      channelTitle: '頻道', publishedAt: null, languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual', bodyMarkdown: '內容',
    });
    const file = documentPathFromId(saved.id)!;
    expect((await stat(path.join(root, file))).isFile()).toBe(true);
    expect(documentIdFromPath(file)).toBe(saved.id);
    expect(documentKeyFromPath(file)).toEqual({ sourceType: saved.sourceType, sourceId: saved.sourceId });
  });
});

// Changing a document's status in the Vault file: publishing and taking back to draft rewrite only
// the top-level `status` and `collector.updated_at`, every other frontmatter byte and the body stay
// as they were, and `updated_at` moves forward. Without it a status change could drop a field
// another tool wrote, reformat the file, or lose the time an import merge decides by.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { transcriptDocument } from '../../src/plugins/youtube/server.js';
import { withDocumentStatus } from '../../src/vault/document-status-edit.js';
import { MarkdownVault } from '../../src/vault/markdown-vault.js';
import { VaultFileWriter } from '../../src/vault/vault-files.js';
import { video } from '../support/exchange-fixtures.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vaultAt(clock: { now: Date }) {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-status-file-'));
  roots.push(root);
  return { root, vault: new MarkdownVault(new VaultFileWriter(root, PRODUCT_SOURCES), { now: () => clock.now }) };
}

/** The file with the `status` and `updated_at` lines taken out, so what remains must not change. */
const withoutStatusLines = (text: string) => text.split('\n').filter((line) => !/^status: |^ {2}updated_at: /u.test(line)).join('\n');
const frontmatterOf = (text: string) => parse(text.match(/^---\n([\s\S]*?)\n---/u)![1]!) as { status?: string; collector: { updated_at?: string } };

/** A document file another tool wrote: no `status`, comments, quoting, flow collections, extra fields, and a body with trailing spaces and no final newline. */
const FOREIGN = `---
type: Transcript
# 由其他工具寫入
title: 'It''s "quoted"'
resource: https://www.youtube.com/watch?v=foreign0001
tags: [研究, 待讀]
aliases:
  - 別名
collector:
  id: youtube:foreign0001   # 文件 ID
  source: youtube
  source_id: foreign0001
  publisher: "頻道：冒號"
  collected_at: 2026-09-01T00:00:00.000Z
  content_extent: full
  subtitle: { language_code: zh-Hant, kind: manual }
  source_tags: []
  note: 其他工具的欄位
---

正文第一行
**粗體** 與 \`code\`


最後一行沒有換行`;

describe('a status change in the document file', () => {
  it('rewrites only status and updated_at of a collected document, and moves updated_at forward', async () => {
    const clock = { now: new Date('2026-11-01T00:00:00.000Z') };
    const { root, vault } = await vaultAt(clock);
    const saved = await vault.add(transcriptDocument(video('collected01', { bodyMarkdown: '第一段。\n\n第二段  有空白。' })));
    const file = path.join(root, 'documents', 'youtube', 'collected01.md');
    const original = await readFile(file, 'utf8');
    expect(frontmatterOf(original)).toMatchObject({ status: 'published', collector: { collected_at: saved.collectedAt } });

    clock.now = new Date('2026-11-02T00:00:00.000Z');
    expect((await vault.writeStatus(saved.id, 'draft')).status).toBe('draft');
    const drafted = await readFile(file, 'utf8');
    expect(withoutStatusLines(drafted)).toBe(withoutStatusLines(original));
    expect(drafted.split('\n').length).toBe(original.split('\n').length + 1);
    expect(frontmatterOf(drafted)).toMatchObject({ status: 'draft', collector: { updated_at: '2026-11-02T00:00:00.000Z' } });
    expect(drafted).toContain(`  collected_at: ${saved.collectedAt}\n  updated_at: 2026-11-02T00:00:00.000Z\n`);

    clock.now = new Date('2026-11-03T00:00:00.000Z');
    expect((await vault.writeStatus(saved.id, 'published')).status).toBe('published');
    const published = await readFile(file, 'utf8');
    expect(withoutStatusLines(published)).toBe(withoutStatusLines(original));
    expect(published.split('\n').length).toBe(drafted.split('\n').length);
    expect(frontmatterOf(published)).toMatchObject({ status: 'published', collector: { updated_at: '2026-11-03T00:00:00.000Z' } });
    expect((await vault.read(saved.id))!.bodyMarkdown).toBe(saved.bodyMarkdown);
  });

  it('keeps every other byte of a file another tool wrote without status', async () => {
    const clock = { now: new Date('2026-11-05T08:00:00.000Z') };
    const { root, vault } = await vaultAt(clock);
    const file = path.join(root, 'documents', 'youtube', 'foreign0001.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, FOREIGN);
    expect((await vault.read('youtube:foreign0001'))!.status).toBe('published');

    await vault.writeStatus('youtube:foreign0001', 'draft');
    const drafted = await readFile(file, 'utf8');
    expect(withoutStatusLines(drafted)).toBe(FOREIGN);
    expect(drafted).toContain('  note: 其他工具的欄位\n---');
    expect(drafted).toContain('aliases:\n  - 別名\nstatus: draft\ncollector:\n');
    expect(drafted).toContain('  collected_at: 2026-09-01T00:00:00.000Z\n  updated_at: 2026-11-05T08:00:00.000Z\n  content_extent: full\n');
    expect(await vault.read('youtube:foreign0001')).toMatchObject({ status: 'draft', title: 'It\'s "quoted"', publisher: { name: '頻道：冒號' } });

    clock.now = new Date('2026-11-05T09:00:00.000Z');
    await vault.writeStatus('youtube:foreign0001', 'published');
    const published = await readFile(file, 'utf8');
    expect(withoutStatusLines(published)).toBe(FOREIGN);
    expect(frontmatterOf(published)).toMatchObject({ status: 'published', collector: { updated_at: '2026-11-05T09:00:00.000Z' } });
  });

  it('replaces existing values in place, keeping their comments, and writes an empty value without a second key', () => {
    const existing = 'type: Transcript\nstatus: published  # 狀態\ncollector:\n  id: youtube:x\n  updated_at: "2026-01-01T00:00:00.000Z"\n  note: n';
    expect(withDocumentStatus(existing, 'draft', '2026-11-01T00:00:00.000Z'))
      .toBe('type: Transcript\nstatus: draft  # 狀態\ncollector:\n  id: youtube:x\n  updated_at: 2026-11-01T00:00:00.000Z\n  note: n');
    const empty = 'type: Transcript\nstatus:\ncollector:\n  id: youtube:x\n  collected_at: 2026-01-01T00:00:00.000Z';
    expect(parse(withDocumentStatus(empty, 'draft', '2026-11-01T00:00:00.000Z'))).toEqual({
      type: 'Transcript', status: 'draft', collector: { id: 'youtube:x', collected_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
    });
  });

  it('writes the same values into frontmatter in flow style', () => {
    const flow = '{ type: Transcript, title: t, collector: { id: "youtube:x", collected_at: "2026-01-01T00:00:00.000Z" } }';
    expect(parse(withDocumentStatus(flow, 'draft', '2026-11-01T00:00:00.000Z'))).toEqual({
      type: 'Transcript', title: 't', status: 'draft',
      collector: { id: 'youtube:x', collected_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
    });
  });
});

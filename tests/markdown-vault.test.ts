import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedTranscript } from '../src/core/types.js';
import { MarkdownVault } from '../src/vault/markdown-vault.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeVault(): Promise<{ root: string; vault: MarkdownVault }> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-vault-test-'));
  temporaryRoots.push(root);
  return { root, vault: new MarkdownVault(root) };
}

const capture: CapturedTranscript = {
  videoId: 'dQw4w9WgXcQ',
  sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: '標題含有：冒號',
  channelId: 'UC123',
  channelTitle: '測試頻道',
  publishedAt: '2026-09-01T08:00:00+08:00',
  languageCode: 'zh-Hant',
  languageName: 'Chinese (Traditional)',
  subtitleKind: 'manual',
  bodyMarkdown: '第一段字幕 第二段字幕',
};

describe('MarkdownVault', () => {
  it('writes portable frontmatter and a clean transcript body', async () => {
    const { root, vault } = await makeVault();
    const saved = await vault.add(capture);
    const markdown = await readFile(
      path.join(root, 'documents', 'youtube', 'dQw4w9WgXcQ.md'),
      'utf8',
    );

    expect(markdown).toContain('id: youtube:dQw4w9WgXcQ');
    expect(markdown.match(/https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/g)).toHaveLength(1);
    expect(markdown).not.toContain('&t=');
    expect(saved.bodyMarkdown).toBe('第一段字幕 第二段字幕');
  });

  it('does not create another document for the same source ID', async () => {
    const { vault } = await makeVault();
    const first = await vault.add(capture);
    const second = await vault.add({ ...capture, title: '不應覆寫' });

    expect(second.title).toBe(first.title);
    expect(await vault.list()).toHaveLength(1);
  });
});

// Broken, a query looks for words the user did not type.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planFragmentQuery } from '../../../src/domain/search/fragment-query.js';
import { loadSearchLexicon } from '../../../src/domain/search/search-lexicon.js';

const resource = path.resolve('resources/search/coct-main.txt');
const lexiconPromise = loadSearchLexicon(resource);

describe('external COCT search lexicon', () => {
  it('matches a frozen Rust jieba-rs 0.10.3 cut(false) oracle', async () => {
    const lexicon = await lexiconPromise;
    const oracle: Array<[string, string[]]> = [
      ['離岸風電', ['離岸', '風電']],
      ['研究生命起源', ['研究', '生命', '起源']],
      ['觀光產業', ['觀光', '產業']],
      ['AI半導體2026', ['AI', '半導體', '2026']],
      ['台越，觀光', ['台', '越', '，', '觀光']],
      ['半導 體', ['半', '導', ' ', '體']],
      ['現金流量', ['現金', '流量']],
      ['南京市長江大橋', ['南京', '市長', '江大橋']],
      ['乾燥幹部頭髮發展', ['乾燥', '幹部', '頭髮', '發展']],
    ];
    for (const [text, words] of oracle) expect(lexicon.cut(text).map(({ word }) => word), text).toEqual(words);
  });

  it('uses Jieba words, adjacent unknown Han runs, quotes and Meili-owned Latin terms', async () => {
    const lexicon = await lexiconPromise;
    expect(planFragmentQuery('觀光產業', lexicon)).toMatchObject({ groups: ['觀光', '產業'], latinQuery: '', hasHan: true });
    expect(planFragmentQuery('台越 觀光', lexicon)).toMatchObject({ groups: ['台越', '觀光'] });
    expect(planFragmentQuery('AI半導體2026', lexicon)).toMatchObject({ groups: ['半導體'], latinQuery: 'ai 2026' });
    expect(planFragmentQuery('"AI 半導體" 供應鏈', lexicon)).toMatchObject({ groups: ['ai 半導體', '供應', '鏈'] });
    expect(planFragmentQuery('離岸風', lexicon).groups).toEqual(['離岸風']);
  });

  it('buffers ASCII like cut(false)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-search-lexicon-'));
    try {
      const dictionaryPath = path.join(root, 'dictionary.txt');
      await writeFile(dictionaryPath, 'abc 100 n\ns 1 n\n');
      expect((await loadSearchLexicon(dictionaryPath)).cut('abcs').map(({ word }) => word)).toEqual(['abc', 's']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a missing file', null, /missing/u],
    ['a zero frequency', Buffer.from('詞 0 n\n'), /invalid frequency/u],
    ['a duplicate word', Buffer.from('詞 1 n\n詞 2 n\n'), /duplicate word/u],
    ['a line without a frequency', Buffer.from('詞\n'), /word frequency/u],
    ['bytes that are not UTF-8', Buffer.from([0xff, 0xfe]), /valid UTF-8/u],
  ])('refuses %s before the engine starts', async (_label, bytes, error) => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-search-lexicon-'));
    try {
      const dictionaryPath = path.join(root, 'dictionary.txt');
      if (bytes) await writeFile(dictionaryPath, bytes);
      await expect(loadSearchLexicon(dictionaryPath)).rejects.toThrow(error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

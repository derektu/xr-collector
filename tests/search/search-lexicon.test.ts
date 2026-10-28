import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { planFragmentQuery } from '../../src/search/fragment-query.js';
import { loadSearchLexicon } from '../../src/search/search-lexicon.js';

const resource = path.resolve('resources/search/coct-main.txt');
const lexiconPromise = loadSearchLexicon(resource);

afterAll(async () => {
  // Keep the large dictionary shared for the whole file; no mutable state is retained by cut().
  await lexiconPromise;
});

describe('external COCT search lexicon', () => {
  it('validates the independently replaceable resource and provenance manifest', async () => {
    const lexicon = await lexiconPromise;
    expect(lexicon.identity).toEqual({
      id: 'coct-news-1141208',
      sha256: '4b2d026eaa353ffde900f36049e72f1fa6902fbf25b14dbcb0b675d541e01264',
      bytes: 2_212_252,
      formatRevision: 1,
      normalizationRevision: 1,
    });
  });

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

  it('rejects missing, malformed and hash-mismatched resources before engine startup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-search-lexicon-'));
    try {
      await expect(loadSearchLexicon(path.join(root, 'missing.txt'))).rejects.toThrow(/missing or invalid/u);
      const dictionary = '觀光 8 n\n半導體 3 n\n';
      const dictionaryPath = path.join(root, 'dictionary.txt');
      const manifestPath = path.join(root, 'dictionary.json');
      await writeFile(dictionaryPath, dictionary);
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1, id: 'fixture', uniqueTerms: 2, normalization: { revision: 1 },
        output: { file: 'dictionary.txt', bytes: Buffer.byteLength(dictionary), sha256: createHash('sha256').update(dictionary).digest('hex') },
      }));
      await expect(loadSearchLexicon(dictionaryPath)).resolves.toMatchObject({ identity: { id: 'fixture' } });
      await writeFile(dictionaryPath, `${await readFile(dictionaryPath, 'utf8')}壞行\n`);
      await expect(loadSearchLexicon(dictionaryPath)).rejects.toThrow(/manifest does not match/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches cut(false) ASCII buffering and rejects unsupported dictionary semantics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-search-lexicon-ascii-'));
    const dictionaryPath = path.join(root, 'dictionary.txt');
    const manifestPath = path.join(root, 'dictionary.json');
    const writeFixture = async (dictionary: Buffer, normalizationRevision = 1) => {
      await writeFile(dictionaryPath, dictionary);
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1, id: 'ascii-fixture', uniqueTerms: dictionary.toString('utf8').trim().split('\n').length,
        normalization: { revision: normalizationRevision },
        output: { file: 'dictionary.txt', bytes: dictionary.length, sha256: createHash('sha256').update(dictionary).digest('hex') },
      }));
    };
    try {
      await writeFixture(Buffer.from('abc 100 n\ns 1 n\n'));
      expect((await loadSearchLexicon(dictionaryPath)).cut('abcs').map(({ word }) => word)).toEqual(['abc', 's']);
      await writeFixture(Buffer.from('詞 0 n\n'));
      await expect(loadSearchLexicon(dictionaryPath)).rejects.toThrow(/invalid frequency/u);
      await writeFixture(Buffer.from('詞 1 n\n'), 2);
      await expect(loadSearchLexicon(dictionaryPath)).rejects.toThrow(/manifest does not match/u);
      await writeFixture(Buffer.from([0xff, 0xfe]));
      await expect(loadSearchLexicon(dictionaryPath)).rejects.toThrow(/valid UTF-8/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

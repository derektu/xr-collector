import { describe, expect, it } from 'vitest';
import { originalSnippet } from '../../src/search/meilisearch-backend.js';
import { normalizeSearchText, normalizeSearchTextWithMap } from '../../src/search/search-normalization.js';

describe('search text normalization', () => {
  it('applies the approved pipeline in order and is idempotent', () => {
    const original = '  ＡＩ\tCoWoS\n００５０ ① 臺灣 台积电  ';
    const normalized = 'ai cowos 0050 1 台灣 台積電';
    expect(normalizeSearchText(original)).toBe(normalized);
    expect(normalizeSearchText(normalized)).toBe(normalized);
  });

  it('uses phrase context for ambiguous simplified characters', () => {
    expect(normalizeSearchText('发展 头发 干燥 干部')).toBe('發展 頭髮 乾燥 幹部');
    expect(normalizeSearchText('一只 一台 台风')).toBe('一隻 一台 颱風');
  });

  it('does not apply Taiwan regional vocabulary or aliases', () => {
    expect(normalizeSearchText('服务器 软件 鼠标 网络')).toBe('服務器 軟件 鼠標 網絡');
    expect(normalizeSearchText('伺服器 軟體 滑鼠 網路')).toBe('伺服器 軟體 滑鼠 網路');
    expect(normalizeSearchText('台積電 TSMC')).toBe('台積電 tsmc');
  });

  it('preserves punctuation, emoji and accents while collapsing only whitespace', () => {
    expect(normalizeSearchText(' Café—AI🙂\u3000\nX ')).toBe('café—ai🙂 x');
    expect(normalizeSearchText('台 積電')).toBe('台 積電');
  });

  it('maps normalized UTF-8 byte positions back to original NFKC and OpenCC spans', () => {
    const original = '前文 ＡＩ、头发與㍿。';
    const projection = normalizeSearchTextWithMap(original);
    expect(projection.text).toBe('前文 ai、頭髮與株式會社。');

    const byteRange = (needle: string) => {
      const start = projection.text.indexOf(needle);
      return { start: Buffer.byteLength(projection.text.slice(0, start)), length: Buffer.byteLength(needle) };
    };
    expect(projection.rawRange(...Object.values(byteRange('ai')) as [number, number])).toEqual({ start: 3, end: 5 });
    const hair = byteRange('髮');
    expect(projection.rawRange(hair.start, hair.length)).toEqual({ start: 7, end: 8 });
    const company = byteRange('會社');
    expect(projection.rawRange(company.start, company.length)).toEqual({ start: 9, end: 10 });
  });
});

describe('original search snippets', () => {
  it('highlights the original characters instead of leaking normalized index text', () => {
    const body = '前文 ＡＩ 與台积电，還有🙂與 <script>alert(1)</script>。';
    const projection = normalizeSearchTextWithMap(body);
    const needle = '台積電';
    const charStart = projection.text.indexOf(needle);
    const match = {
      start: Buffer.byteLength(projection.text.slice(0, charStart)),
      length: Buffer.byteLength(needle),
    };
    const snippet = originalSnippet(body, [match]);
    expect(snippet).toContain('<mark>台积电</mark>');
    expect(snippet).toContain('ＡＩ');
    expect(snippet).toContain('🙂');
    expect(snippet).toContain('<script>alert(1)</script>');
    expect(snippet).not.toContain('台積電');
  });

  it('does not split surrogate pairs at crop boundaries', () => {
    const body = `${'a'.repeat(80)}🙂target${'b'.repeat(180)}`;
    const projection = normalizeSearchTextWithMap(body);
    const charStart = projection.text.indexOf('target');
    const snippet = originalSnippet(body, [{
      start: Buffer.byteLength(projection.text.slice(0, charStart)),
      length: Buffer.byteLength('target'),
    }]);
    expect(snippet).toContain('🙂<mark>target</mark>');
    expect(snippet).not.toContain('\uFFFD');
  });
});

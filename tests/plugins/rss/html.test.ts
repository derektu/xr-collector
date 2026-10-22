import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, htmlToText } from '../../../src/plugins/rss/html.js';

const BASE = 'https://example.com/posts/1';

describe('article HTML as Markdown (R11-T3)', () => {
  it('converts headings, paragraphs, emphasis, lists, code and quotes', async () => {
    expect(await htmlToMarkdown(
      '<h2>小標</h2><p>一段 <strong>粗體</strong> 與 <em>斜體</em>。</p><ul><li>甲</li><li>乙</li></ul><ol><li>一</li></ol>'
      + '<pre><code>const x = 1;</code></pre><blockquote><p>引言</p></blockquote>',
      BASE,
    )).toBe('## 小標\n\n一段 **粗體** 與 *斜體*。\n\n- 甲\n- 乙\n\n1. 一\n\n```\nconst x = 1;\n```\n\n> 引言');
  });

  it('resolves relative links and images against the base and keeps images as remote images', async () => {
    expect(await htmlToMarkdown('<p><a href="../about">關於</a> <a href="https://other.example/x">外部</a></p><img src="img/a.png" alt="示意圖">', BASE))
      .toBe('[關於](https://example.com/about) [外部](https://other.example/x)\n\n![示意圖](https://example.com/posts/img/a.png)');
    expect(await htmlToMarkdown('<img data-src="/lazy.png" alt="延遲">', BASE)).toBe('![延遲](https://example.com/lazy.png)');
  });

  it('keeps only the text of links that lead nowhere and leaves out images without an address', async () => {
    expect(await htmlToMarkdown('<p><a href="javascript:alert(1)">按我</a> 和 <a>錨點</a><img alt="無"></p>', BASE)).toBe('按我 和 錨點');
  });

  it('turns a simple table into a GFM table and a table with merged cells into one paragraph per row', async () => {
    expect(await htmlToMarkdown('<table><tr><th>名稱</th><th>數量</th></tr><tr><td>蘋果</td><td>3</td></tr></table>', BASE))
      .toBe('| 名稱 | 數量 |\n| -- | -- |\n| 蘋果 | 3  |');
    expect(await htmlToMarkdown('<table><tr><td colspan="2">合併</td></tr><tr><td>左</td><td>右</td></tr></table>', BASE))
      .toBe('合併\n\n左 / 右');
    expect(await htmlToMarkdown('<table><tr><td>外<table><tr><td>內</td></tr></table></td></tr></table>', BASE))
      .toBe('外內');
  });

  it('turns an embedded frame into a link and leaves out scripts, styles and forms', async () => {
    expect(await htmlToMarkdown(
      '<p>前</p><script>alert(1)</script><style>p{}</style><form><input value="x"><button>送出</button></form>'
      + '<iframe src="https://video.example/embed/1" title="影片"></iframe><iframe src="/frame"></iframe>',
      BASE,
    )).toBe('前\n\n[影片](https://video.example/embed/1)\n\n<https://example.com/frame>');
  });

  it('turns a video or audio into a link to a source that resolves and leaves out comments', async () => {
    expect(await htmlToMarkdown(
      '<p>前<!-- 註解 --></p><video src="javascript:alert(1)" poster="/p.png"><source src="javascript:alert(2)"><source src="/v.mp4"></video>'
      + '<audio src="/a.mp3" title="音檔"></audio><video src="javascript:alert(3)"></video>',
      BASE,
    )).toBe('前\n\n<https://example.com/v.mp4>\n\n[音檔](https://example.com/a.mp3)');
  });

  it('gives an empty body for no content and plain text for a title', async () => {
    expect(await htmlToMarkdown('   ', BASE)).toBe('');
    expect(htmlToText('A <i>b</i> &amp; c')).toBe('A b & c');
    expect(htmlToText('沒有標記')).toBe('沒有標記');
  });
});

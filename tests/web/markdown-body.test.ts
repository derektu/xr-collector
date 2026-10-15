import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownBody } from '../../src/web/MarkdownBody.js';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(MarkdownBody, { markdown }));
}

describe('MarkdownBody', () => {
  it('renders headings, lists, emphasis and external links as Markdown', () => {
    const html = render('## 小標\n\n- 第一點\n- **第二點**\n\n見[原始頁面](https://example.com/a)。');
    expect(html).toContain('<h2>小標</h2>');
    expect(html).toContain('<li><strong>第二點</strong></li>');
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">原始頁面</a>');
  });

  it('never turns body content into executable markup', () => {
    const html = render([
      '<script>alert(1)</script>',
      '<img src="x" onerror="alert(2)">',
      '[危險連結](javascript:alert(3))',
      '![圖](https://example.com/p.png)',
    ].join('\n\n'));
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<img/u);
    expect(html).not.toContain('onerror="');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('圖片：圖');
  });
});

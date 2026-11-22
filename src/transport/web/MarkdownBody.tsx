import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt }) => typeof src === 'string' && src
    ? <a href={src} target="_blank" rel="noopener noreferrer">{alt ? `圖片：${alt}` : '圖片'}</a>
    : null,
};

// With skipHtml false, react-markdown keeps raw HTML in the body as plain text instead of dropping it.
// https://github.com/remarkjs/react-markdown#appendix-a-html-in-markdown
export function MarkdownBody({ markdown }: { markdown: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml={false}>{markdown}</Markdown>;
}

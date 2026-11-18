import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  // External pages open outside the app; Electron hands new windows to the system browser.
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  // Remote images are not fetched while reading; the image stays reachable as a link.
  img: ({ src, alt }) => typeof src === 'string' && src
    ? <a href={src} target="_blank" rel="noopener noreferrer">{alt ? `圖片：${alt}` : '圖片'}</a>
    : null,
};

/**
 * Renders a document body as Markdown. Raw HTML in the body is not interpreted, and links that are
 * not http(s), mailto or relative are removed by react-markdown's URL transform.
 */
export function MarkdownBody({ markdown }: { markdown: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml={false}>{markdown}</Markdown>;
}

import { useEffect, useState } from 'react';
import type { SavedDocument } from '../core/types.js';
import { ApiError, api } from './api-client.js';
import { collectedLabel, publishedLabel, sourceTag, subtitleLabel } from './document-presentation.js';
import { MarkdownBody } from './MarkdownBody.js';

type ReaderState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: SavedDocument }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** Full-width reading view for one document; the shell collapses its sidebar while this is open. */
export function Reader({ id, onBack }: { id: string; onBack: () => void }) {
  const [state, setState] = useState<ReaderState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    api.readDocument(id, controller.signal).then((document) => setState({ kind: 'ready', document })).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'document_not_found') setState({ kind: 'missing' });
      else setState({ kind: 'error', message: error instanceof Error ? error.message : '無法讀取這份文件。' });
    });
    return () => controller.abort();
  }, [id]);

  return <div className="reader" data-testid="reader">
    <div className="reader-bar">
      <button type="button" className="reader-back" onClick={onBack}><span aria-hidden="true">←</span> 返回文件列表</button>
    </div>
    <article className="reader-article">
      {state.kind === 'loading' ? <p className="loading" role="status">正在載入文件…</p> : null}
      {state.kind === 'missing' ? <section className="reader-missing" data-testid="reader-missing">
        <h1 className="reader-title">找不到這份文件</h1>
        <p>這份文件可能已被移除，或網址有誤。返回文件列表可以重新搜尋或瀏覽。</p>
      </section> : null}
      {state.kind === 'error' ? <p className="documents-error" role="alert">{state.message}</p> : null}
      {state.kind === 'ready' ? <ReaderDocument document={state.document} /> : null}
    </article>
  </div>;
}

function ReaderDocument({ document }: { document: SavedDocument }) {
  const subtitle = subtitleLabel(document);
  return <>
    <header className="reader-header">
      <span className="source-tag">{sourceTag(document)}</span>
      <h1 className="reader-title" tabIndex={-1}>{document.title}</h1>
      <p className="reader-meta">
        <span className={document.publishedAt ? undefined : 'unknown'}>{publishedLabel(document.publishedAt)}</span>
        <span>{collectedLabel(document.collectedAt)}</span>
        {subtitle ? <span>{subtitle}</span> : null}
      </p>
      <p className="reader-source">
        原始網址：<a href={document.sourceUrl} target="_blank" rel="noopener noreferrer" data-testid="reader-source-link">{document.sourceUrl}</a>
      </p>
    </header>
    <div className="reader-body" data-testid="reader-body"><MarkdownBody markdown={document.bodyMarkdown} /></div>
  </>;
}

import { useEffect, useRef, useState } from 'react';
import type { SavedDocument } from '../core/types.js';
import { sourceDeclaration } from '../core/source-registry.js';
import { ApiError, api } from './api-client.js';
import { ConfirmDeleteDocument } from './ConfirmDeleteDocument.js';
import { collectedLabel, publishedLabel, sourceUrlOfDocumentId, subtitleLabel } from './document-presentation.js';
import { Icon } from './icons.js';
import { MarkdownBody } from './MarkdownBody.js';
import { sourcePath } from './source-presentation.js';
import { readUntil, useChanges } from './use-changes.js';

type ReaderState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: SavedDocument }
  | { kind: 'missing' }
  | { kind: 'deleted' }
  | { kind: 'error'; message: string };

/** How collecting a deleted document again is going. */
type Recollect = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; message: string };

/** Full-width reading view for one document; the shell collapses its sidebar while this is open. */
/** `backLabel` names the page the Back control returns to. */
export function Reader({ id, backLabel, onBack, onOpenSource, onDeleted }: {
  id: string;
  backLabel: string;
  onBack: () => void;
  onOpenSource: (type: string, id: string) => void;
  /** Called after the document is deleted; the Reader has nothing left to show. */
  onDeleted: (message: string) => void;
}) {
  const [state, setState] = useState<ReaderState>({ kind: 'loading' });
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [recollect, setRecollect] = useState<Recollect>({ kind: 'idle' });
  const subscriptionChanges = useChanges(['documents'], (change) => change.kind === 'subscription');
  const documentChanges = useChanges(['documents'], (change) => change.kind === 'document' && change.id === id);
  const shownId = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    subscriptionChanges.track(api.listSubscriptions(controller.signal)
      .then((list) => setSubscribed(new Set(list.subscriptions.map((source) => `${source.type}:${source.id}`)))));
    return () => controller.abort();
  }, [subscriptionChanges.tick]);

  // A change to the document reads it again in place; another document starts from the loading state.
  useEffect(() => {
    const controller = new AbortController();
    if (shownId.current !== id) setState({ kind: 'loading' });
    shownId.current = id;
    documentChanges.track(api.readDocument(id, controller.signal).then((document) => setState({ kind: 'ready', document })).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'document_not_found') setState({ kind: 'missing' });
      else if (error instanceof ApiError && error.code === 'document_deleted') setState({ kind: 'deleted' });
      else { setState({ kind: 'error', message: error instanceof Error ? error.message : '無法讀取這份文件。' }); throw error; }
    }));
    return () => controller.abort();
  }, [id, documentChanges.tick]);

  // An explicit single-address collection, the one way a deleted document comes back.
  useEffect(() => {
    if (recollect.kind !== 'running') return undefined;
    let active = true;
    const following = new AbortController();
    const url = sourceUrlOfDocumentId(id);
    const type = id.slice(0, Math.max(0, id.indexOf(':')));
    const item = sourceDeclaration(type)?.item;
    const finish = (next: Recollect) => { if (active) setRecollect(next); };
    // The collected document's own change reads it again; this only reports how the job ended.
    const follow = (jobId: string) => readUntil(() => api.getJob(jobId), (job) => job.state !== 'queued' && job.state !== 'running',
      (change) => change.kind === 'job' && change.id === jobId, following.signal).then((job) => {
      if (job.state === 'completed' && (job.result?.outcome === 'created' || job.result?.outcome === 'existing')) finish({ kind: 'idle' });
      else finish({ kind: 'failed', message: job.error?.message ?? `這${item?.measure ?? '份'}${item?.noun ?? '文件'}沒有收集回來，請到記錄頁查看原因。` });
    });
    if (!url) finish({ kind: 'failed', message: '無法辨識這份文件的網址。' });
    else api.collect(url).then((submission) => follow(submission.job.id))
      .catch((error: unknown) => finish({ kind: 'failed', message: error instanceof Error ? error.message : '無法重新收集，請稍後再試。' }));
    return () => { active = false; following.abort(); };
  }, [recollect.kind, id]);

  return <div className="reader" data-testid="reader">
    <div className="reader-bar">
      <button type="button" className="button" onClick={onBack}><Icon name="back" size={15} />{backLabel}</button>
      <span className="spacer" />
      {state.kind === 'ready' ? <a className="button" href={state.document.sourceUrl} target="_blank" rel="noopener noreferrer" data-testid="reader-source-link">
        <Icon name="external" size={15} />{sourceDeclaration(state.document.sourceType)?.item.openOriginalLabel ?? '開啟原始內容'}
      </a> : null}
      <button type="button" className="button icon" aria-label="刪除文件" title="刪除文件" disabled={state.kind !== 'ready'}
        onClick={() => setDeleting(true)} data-testid="reader-delete"><Icon name="trash" size={15} /></button>
    </div>
    <article className="reader-article">
      {state.kind === 'loading' ? <p className="loading" role="status">正在載入文件…</p> : null}
      {state.kind === 'missing' ? <section className="reader-missing" data-testid="reader-missing">
        <h1 className="reader-title">找不到這份文件</h1>
        <p>這份文件可能已被移除，或網址有誤。回到文件頁可以重新搜尋或瀏覽。</p>
      </section> : null}
      {state.kind === 'deleted' ? <section className="reader-missing" data-testid="reader-deleted">
        <h1 className="reader-title">這份文件已刪除</h1>
        {recollect.kind === 'failed' ? <p className="add-problem" role="alert">{recollect.message}</p> : null}
        {sourceUrlOfDocumentId(id) ? <button type="button" className="button primary" disabled={recollect.kind === 'running'} onClick={() => setRecollect({ kind: 'running' })}
          data-testid="reader-recollect">{recollect.kind === 'running' ? '收集中…' : '重新收集'}</button> : null}
      </section> : null}
      {state.kind === 'error' ? <p className="documents-error" role="alert">{state.message}</p> : null}
      {state.kind === 'ready' ? <ReaderDocument document={state.document} subscribed={subscribed.has(`${state.document.sourceType}:${state.document.publisher.id}`)} onOpenSource={onOpenSource} /> : null}
    </article>
    {deleting && state.kind === 'ready' ? <ConfirmDeleteDocument document={state.document} onCancel={() => setDeleting(false)}
      onDeleted={(message) => { setDeleting(false); onDeleted(message); }} /> : null}
  </div>;
}

function ReaderDocument({ document, subscribed, onOpenSource }: { document: SavedDocument; subscribed: boolean; onOpenSource: (type: string, id: string) => void }) {
  const subtitle = subtitleLabel(document);
  const publisherId = document.publisher.id;
  return <>
    <header className="reader-header">
      {subscribed && publisherId
        ? <a className="reader-publisher" href={sourcePath(document.sourceType, publisherId)} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpenSource(document.sourceType, publisherId);
        }} data-testid="reader-publisher"><Icon name={document.sourceType} size={14} />{document.publisher.name}</a>
        : <span className="reader-publisher" data-testid="reader-publisher"><Icon name={document.sourceType} size={14} />{document.publisher.name}</span>}
      <h1 className="reader-title" tabIndex={-1}>{document.title}</h1>
      <p className="reader-meta">
        <span className={document.publishedAt ? undefined : 'unknown'}>{publishedLabel(document.publishedAt)}</span>
        <span>{collectedLabel(document.collectedAt)}</span>
        {subtitle ? <span>{subtitle}</span> : null}
      </p>
    </header>
    <div className="reader-body" data-testid="reader-body"><MarkdownBody markdown={document.bodyMarkdown} /></div>
  </>;
}

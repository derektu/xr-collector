import { useEffect, useState } from 'react';
import type { SavedDocument } from '../core/types.js';
import { ApiError, api } from './api-client.js';
import { ConfirmDeleteDocument } from './ConfirmDeleteDocument.js';
import { collectedLabel, publishedLabel, sourceUrlOfDocumentId, subtitleLabel } from './document-presentation.js';
import { Icon } from './icons.js';
import { MarkdownBody } from './MarkdownBody.js';
import { sourcePath } from './source-presentation.js';

type ReaderState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: SavedDocument }
  | { kind: 'missing' }
  | { kind: 'deleted' }
  | { kind: 'error'; message: string };

/** How collecting a deleted document again is going. */
type Recollect = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; message: string };

const RECOLLECT_POLL_MS = 1000;

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
  /** Bumped to read the document again after it was collected again. */
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.listSources(controller.signal).then((list) => setSubscribed(new Set(list.sources.map((source) => `${source.type}:${source.id}`)))).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    api.readDocument(id, controller.signal).then((document) => setState({ kind: 'ready', document })).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'document_not_found') setState({ kind: 'missing' });
      else if (error instanceof ApiError && error.code === 'document_deleted') setState({ kind: 'deleted' });
      else setState({ kind: 'error', message: error instanceof Error ? error.message : '無法讀取這份文件。' });
    });
    return () => controller.abort();
  }, [id, revision]);

  // An explicit single-address collection, the one way a deleted document comes back.
  useEffect(() => {
    if (recollect.kind !== 'running') return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = sourceUrlOfDocumentId(id);
    const finish = (next: Recollect, reload: boolean) => {
      if (!active) return;
      setRecollect(next);
      if (reload) setRevision((value) => value + 1);
    };
    const poll = (jobId: string) => {
      timer = setTimeout(() => {
        api.getJob(jobId).then((job) => {
          if (job.state === 'queued' || job.state === 'running') poll(jobId);
          else if (job.state === 'completed' && (job.result?.outcome === 'created' || job.result?.outcome === 'existing')) finish({ kind: 'idle' }, true);
          else finish({ kind: 'failed', message: job.error?.message ?? '這支影片沒有收集回來，請到記錄頁查看原因。' }, false);
        }).catch(() => poll(jobId));
      }, RECOLLECT_POLL_MS);
    };
    if (!url) finish({ kind: 'failed', message: '無法辨識這份文件的網址。' }, false);
    else api.collectYouTube(url).then((submission) => poll(submission.job.id))
      .catch((error: unknown) => finish({ kind: 'failed', message: error instanceof Error ? error.message : '無法重新收集，請稍後再試。' }, false));
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [recollect.kind, id]);

  return <div className="reader" data-testid="reader">
    <div className="reader-bar">
      <button type="button" className="button" onClick={onBack}><Icon name="back" size={15} />{backLabel}</button>
      <span className="spacer" />
      {state.kind === 'ready' ? <a className="button" href={state.document.sourceUrl} target="_blank" rel="noopener noreferrer" data-testid="reader-source-link">
        <Icon name="external" size={15} />{state.document.sourceType === 'youtube' ? '開啟原始影片' : '開啟原始內容'}
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
        <button type="button" className="button primary" disabled={recollect.kind === 'running'} onClick={() => setRecollect({ kind: 'running' })}
          data-testid="reader-recollect">{recollect.kind === 'running' ? '收集中…' : '重新收集'}</button>
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

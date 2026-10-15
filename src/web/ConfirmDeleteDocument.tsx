import { useEffect, useRef, useState } from 'react';
import type { DocumentMetadata } from '../core/types.js';
import { api, ApiError } from './api-client.js';
import { DELETE_CONFIRMATION } from './document-presentation.js';

/** Confirms deleting a document; the subscription it came from stays. */
export function ConfirmDeleteDocument({ document, onCancel, onDeleted }: {
  document: Pick<DocumentMetadata, 'id' | 'title'>;
  onCancel: () => void;
  onDeleted: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function remove(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await api.deleteDocument(document.id);
      onDeleted(`已刪除「${document.title}」。`);
    } catch (error) {
      // Deleted elsewhere meanwhile, such as by an Agent or another window: the outcome is the same.
      if (error instanceof ApiError && error.code === 'document_deleted') {
        onDeleted(`已刪除「${document.title}」。`);
        return;
      }
      setFailure(error instanceof Error ? error.message : '無法刪除，請稍後再試。');
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-delete-title" data-testid="confirm-delete-document"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="confirm-delete-title">刪除「{document.title}」？</h2>
    <p>{DELETE_CONFIRMATION}</p>
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      <button type="button" className="button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? '刪除中…' : '刪除'}</button>
    </div>
  </dialog>;
}

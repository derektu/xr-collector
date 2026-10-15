import { useEffect, useRef, useState } from 'react';
import type { Subscription } from '../core/types.js';
import { api } from './api-client.js';
import { removeConfirmation } from './subscription-presentation.js';

/** Confirms removing a subscription; its documents stay in the Vault. */
export function ConfirmRemove({ source, onCancel, onRemoved }: {
  source: Pick<Subscription, 'id' | 'title' | 'documentCount'>;
  onCancel: () => void;
  onRemoved: (message: string) => void;
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
      const { documentsKept } = await api.removeChannel(source.id);
      onRemoved(`已移除「${source.title}」，保留 ${documentsKept} 份文件。`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法移除，請稍後再試。');
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-remove-title" data-testid="confirm-remove"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id="confirm-remove-title">移除「{source.title}」？</h2>
    <p>{removeConfirmation(source)}</p>
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      <button type="button" className="button" onClick={onCancel}>取消</button>
      <button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? '移除中…' : '移除'}</button>
    </div>
  </dialog>;
}

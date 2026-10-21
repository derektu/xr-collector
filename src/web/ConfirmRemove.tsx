import { useEffect, useRef, useState } from 'react';
import type { SubscriptionEntry } from '../core/types.js';
import { api } from './api-client.js';
import { asksAboutDocuments, removeChoices, removedMessage } from './subscription-presentation.js';

/** Confirms removing a subscription and asks whether its documents stay (the default) or go with it. */
export function ConfirmRemove({ source, onCancel, onRemoved }: {
  source: Pick<SubscriptionEntry, 'type' | 'id' | 'title' | 'documentCount' | 'checkStatus' | 'capturing'>;
  onCancel: () => void;
  onRemoved: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [documents, setDocuments] = useState<'keep' | 'delete'>('keep');
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
      const result = await api.removeSubscription(source.type, source.id, documents);
      onRemoved(removedMessage(source.title, documents === 'delete' ? result : null));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法移除，請稍後再試。');
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-remove-title" data-testid="confirm-remove"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="confirm-remove-title">移除「{source.title}」？</h2>
    {asksAboutDocuments(source) ? <fieldset className="choice-list" disabled={busy}>
      <legend className="visually-hidden">文件</legend>
      {removeChoices(source).map((choice) => <label key={choice.value} className="choice">
        <input type="radio" name="remove-documents" value={choice.value} checked={documents === choice.value}
          onChange={() => setDocuments(choice.value)} data-testid={`remove-${choice.value}`} />
        <span>{choice.label}</span>
      </label>)}
    </fieldset> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      <button type="button" className="button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="button danger" disabled={busy} onClick={() => void remove()} data-testid="confirm-remove-button">{busy ? '移除中…' : '移除'}</button>
    </div>
  </dialog>;
}

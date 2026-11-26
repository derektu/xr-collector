import { useState } from 'react';
import type { SubscriptionEntry } from '../../shared/subscriptions/subscription-types.js';
import { api } from './api-client.js';
import { showModalOnMount } from './infra/dialog.js';
import { useRead } from './infra/use-read.js';

export function ConfirmApplySettings({ source, onCancel, onApplied }: {
  source: Pick<SubscriptionEntry, 'id' | 'type' | 'kind' | 'kindLabel'>;
  onCancel: () => void;
  onApplied: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const read = useRead(async (signal) => {
    const list = await api.listSubscriptions(signal);
    const same = list.subscriptions.filter((entry) => entry.type === source.type && entry.kind === source.kind && entry.id !== source.id);
    return { total: same.length, paused: same.filter((entry) => !entry.enabled).length };
  }, [source.id, source.type, source.kind]);
  const others = read.value;
  const shownFailure = failure ?? (read.error ? (read.error instanceof Error ? read.error.message : '無法讀取訂閱。') : null);

  async function apply(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const { updated } = await api.applySubscriptionSettings(source.type, source.id);
      onApplied(`已套用到 ${updated} 個 ${source.kindLabel}。`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法套用，請稍後再試。');
      setBusy(false);
    }
  }

  const count = others ? `其他 ${others.total} 個 ${source.kindLabel}${others.paused > 0 ? `（含 ${others.paused} 個已暫停）` : ''}` : null;
  return <dialog ref={showModalOnMount} className="confirm-dialog" aria-labelledby="confirm-apply-title" data-testid="confirm-apply-settings"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id="confirm-apply-title">套用到所有 {source.kindLabel}？</h2>
    <p>{count ? `把這組收集設定套用到${count}？` : '正在讀取…'}</p>
    {shownFailure ? <p className="add-problem" role="alert">{shownFailure}</p> : null}
    <div className="dialog-actions">
      <button type="button" className="button" onClick={onCancel}>取消</button>
      <button type="button" className="button primary" disabled={busy || !others || others.total === 0} onClick={() => void apply()} data-testid="confirm-apply">
        {busy ? '套用中…' : '套用'}
      </button>
    </div>
  </dialog>;
}

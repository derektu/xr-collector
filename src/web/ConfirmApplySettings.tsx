import { useEffect, useRef, useState } from 'react';
import type { SourceEntry } from '../core/types.js';
import { api } from './api-client.js';

/**
 * Confirms giving every other source of the same kind this source's collection settings. The
 * count includes paused sources, which take the settings and stay paused.
 */
export function ConfirmApplySettings({ source, onCancel, onApplied }: {
  source: Pick<SourceEntry, 'id' | 'type' | 'kind' | 'kindLabel'>;
  onCancel: () => void;
  onApplied: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [others, setOthers] = useState<{ total: number; paused: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    const controller = new AbortController();
    api.listSources(controller.signal).then((list) => {
      const same = list.sources.filter((entry) => entry.type === source.type && entry.kind === source.kind && entry.id !== source.id);
      setOthers({ total: same.length, paused: same.filter((entry) => !entry.enabled).length });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : '無法讀取訂閱。');
    });
    return () => controller.abort();
  }, [source.id, source.type, source.kind]);

  async function apply(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const { updated } = await api.applyChannelSettings(source.id);
      onApplied(`已套用到 ${updated} 個 ${source.kindLabel}。`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '無法套用，請稍後再試。');
      setBusy(false);
    }
  }

  const count = others ? `其他 ${others.total} 個 ${source.kindLabel}${others.paused > 0 ? `（含 ${others.paused} 個已暫停）` : ''}` : null;
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-apply-title" data-testid="confirm-apply-settings"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id="confirm-apply-title">套用到所有 {source.kindLabel}？</h2>
    <p>{count ? `把這組收集設定套用到${count}？` : '正在讀取…'}</p>
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      <button type="button" className="button" onClick={onCancel}>取消</button>
      <button type="button" className="button primary" disabled={busy || !others || others.total === 0} onClick={() => void apply()} data-testid="confirm-apply">
        {busy ? '套用中…' : '套用'}
      </button>
    </div>
  </dialog>;
}

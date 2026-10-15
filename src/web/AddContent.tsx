import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RecognitionAction, UrlRecognition } from '../core/types.js';
import { api } from './api-client.js';
import { Icon, SourceTypeBadge } from './icons.js';
import { currentRecognition, initials } from './source-presentation.js';
import { backfillPhrase, subscribeSummary } from './subscription-presentation.js';

const RECOGNIZE_DELAY_MS = 500;

type Recognition =
  | { state: 'idle' }
  | { state: 'recognizing' }
  | { state: 'done'; input: string; recognition: UrlRecognition }
  | { state: 'error'; message: string };

/** What the dialog reports after an action succeeded. */
export interface AddResult {
  message: string;
  /** The subscription the action created or resumed, when there is one to show. */
  source?: { type: string; id: string };
}

/**
 * The Add Content dialog. Pasting an address asks the service what it is; the card and buttons
 * come from that answer, so the dialog needs no knowledge of individual source types.
 */
export function AddContent({ onClose, onDone, onOpenSource, onOpenSettings }: {
  onClose: () => void;
  onDone: (result: AddResult) => void;
  onOpenSource: (type: string, id: string) => void;
  onOpenSettings: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [recognition, setRecognition] = useState<Recognition>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    input.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = url.trim();
    setFailure(null);
    if (!trimmed) { sequence.current += 1; setRecognition({ state: 'idle' }); return undefined; }
    const current = ++sequence.current;
    const controller = new AbortController();
    // Any edit invalidates the previous answer at once, so its card and action cannot be used
    // for the new address while the debounce runs.
    setRecognition({ state: 'recognizing' });
    const timer = setTimeout(() => {
      api.recognizeUrl(trimmed, controller.signal).then((result) => {
        if (current === sequence.current) setRecognition({ state: 'done', input: trimmed, recognition: result });
      }).catch((error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        setRecognition({ state: 'error', message: error instanceof Error ? error.message : '無法辨識這個網址。' });
      });
    }, RECOGNIZE_DELAY_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [url]);

  async function perform(action: RecognitionAction, found: UrlRecognition): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await api.performAction(action);
      const title = found.target?.title;
      const message = action.id === 'collect' ? '已開始收集影片，完成後會出現在文件中。'
        : action.id === 'subscribe' ? `已訂閱「${title}」，開始首次收集。`
          : `已恢復「${title}」，開始補收。`;
      onDone({ message, ...(found.kind === 'channel' && found.target && found.sourceType ? { source: { type: found.sourceType, id: found.target.id } } : {}) });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '操作失敗，請稍後再試。');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const answer = currentRecognition(recognition.state === 'done' ? recognition : null, input.current?.value ?? url);
    if (answer?.primary && !busy) void perform(answer.primary, answer.recognition);
  }

  const answer = currentRecognition(recognition.state === 'done' ? recognition : null, url);
  const found = answer?.recognition ?? null;
  const primary = answer?.primary ?? null;
  return <dialog ref={dialog} className="add-dialog" aria-label="加入內容" data-testid="add-dialog"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <form className="add-body" onSubmit={submit}>
      <div className="add-tabs" role="tablist" aria-label="加入方式">
        <button type="button" className="add-tab active" role="tab" aria-selected="true"><Icon name="link" size={15} />貼網址</button>
        <button type="button" className="icon-only close-button" aria-label="關閉" onClick={onClose}><Icon name="close" /></button>
      </div>
      <label className="field-label" htmlFor="add-url">網址</label>
      <input ref={input} id="add-url" className="url-input" type="text" inputMode="url" value={url} autoComplete="off" spellCheck={false}
        placeholder="貼上 YouTube 影片或頻道網址" onChange={(event) => setUrl(event.target.value)} data-testid="add-url" />

      {recognition.state === 'recognizing' ? <p className="add-status" role="status"><span className="spinner" aria-hidden="true" />正在辨識網址…</p> : null}
      {recognition.state === 'error' ? <p className="add-problem" role="alert">{recognition.message}</p> : null}
      {found ? <RecognitionCard recognition={found} onOpenSource={onOpenSource} onOpenSettings={onOpenSettings} /> : null}
      {failure ? <p className="add-problem" role="alert">{failure}</p> : null}

      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        {primary ? <button type="submit" className="button primary" disabled={busy} data-testid="add-confirm">{busy ? '處理中…' : primary.label}</button> : null}
      </div>
    </form>
  </dialog>;
}

function RecognitionCard({ recognition, onOpenSource, onOpenSettings }: {
  recognition: UrlRecognition;
  onOpenSource: (type: string, id: string) => void;
  onOpenSettings: () => void;
}) {
  if (recognition.status === 'unsupported' || recognition.status === 'unavailable') {
    return <div className="recognition-card problem" role="alert" data-testid="recognition-card">
      <p className="card-kind">{recognition.status === 'unsupported' ? '無法加入這個網址' : `無法讀取${recognition.kindLabel ?? '這個來源'}`}</p>
      <p>{recognition.message}</p>
    </div>;
  }
  if (recognition.status === 'login_required' && recognition.login) {
    return <div className="recognition-card" data-testid="recognition-card">
      <p className="card-kind">需要先登入 {recognition.login.label}</p>
      <p>{recognition.login.message}</p>
    </div>;
  }
  const target = recognition.target;
  if (!target) return null;
  if (recognition.kind === 'video') {
    return <div className="recognition-card" data-testid="recognition-card">
      <SourceTypeBadge icon={recognition.sourceType ?? 'file'} />
      <div className="card-main">
        <p className="card-kind">{recognition.kindLabel}</p>
        <p className="card-title">{target.url.replace(/^https:\/\/(www\.)?/u, '')}</p>
        <p>收集這支影片的字幕，加入知識庫。</p>
      </div>
    </div>;
  }
  const subscription = recognition.subscription;
  const policy = recognition.policy;
  return <div className="recognition-card" data-testid="recognition-card">
    <span className="avatar" aria-hidden="true">{initials(target.title ?? '')}</span>
    <div className="card-main">
      <p className="card-kind"><Icon name={recognition.sourceType ?? 'file'} size={14} />{recognition.kindLabel}</p>
      <p className="card-title">{target.title}{subscription ? <span className={`status-chip ${subscription.enabled ? 'tracking' : 'paused'}`}>{subscription.enabled ? '已訂閱' : '已暫停'}</span> : null}</p>
      {!subscription && policy ? <p>{subscribeSummary(policy).text}所有訂閱共用<button type="button" className="inline-link" onClick={onOpenSettings}>自動收集設定</button>。</p> : null}
      {subscription?.enabled ? <p>這個頻道已在來源中，會依自動收集設定持續檢查新影片。<button type="button" className="inline-link" onClick={() => onOpenSource(recognition.sourceType!, subscription.id)}>查看來源</button></p> : null}
      {subscription && !subscription.enabled && policy ? <p>這個訂閱已暫停。恢復後補收{backfillPhrase(policy)}，再依自動收集設定持續檢查。</p> : null}
    </div>
  </div>;
}

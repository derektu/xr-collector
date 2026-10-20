import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CollectionPolicy, RecognitionAction, SourceSettingField, SourceTypeInfo, UrlRecognition } from '../core/types.js';
import { ADD_DIALOG_TITLES, addMismatch, isUnsupportedUrl, UNSUPPORTED_URL, type AddMode } from './add-menu.js';
import { api } from './api-client.js';
import { CollectionSettingsFields } from './CollectionSettingsFields.js';
import { Icon, SourceTypeBadge } from './icons.js';
import { currentRecognition, initials } from './source-presentation.js';
import { resumeSummary, subscribeSummary } from './subscription-presentation.js';

const RECOGNIZE_DELAY_MS = 500;

type Recognition =
  | { state: 'idle' }
  | { state: 'recognizing' }
  | { state: 'done'; input: string; recognition: UrlRecognition }
  | { state: 'error'; message: string };

const PLACEHOLDERS: Record<AddMode, string> = { url: '貼上 YouTube 影片網址', 'youtube-channel': '貼上 YouTube 頻道網址或 @handle' };

/**
 * The add dialog of one mode: 加入網址 adds one document, 訂閱 YouTube 頻道 adds a subscription.
 * Pasting an address asks the service what it is; the card and the action come from that answer,
 * and a new subscription's settings fields from its source type's declaration. An address of the
 * other kind offers to switch dialogs, keeping the address.
 */
export function AddContent({ mode: initialMode, sourceTypes, onClose, onDone, onOpenSource }: {
  mode: AddMode;
  sourceTypes: SourceTypeInfo[];
  onClose: () => void;
  /** The action was accepted with this response; the dialog's work is done. */
  onDone: (response: unknown) => void;
  onOpenSource: (type: string, id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState(initialMode);
  const [url, setUrl] = useState('');
  const [recognition, setRecognition] = useState<Recognition>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** The settings chosen on the card; they belong to the recognition they were chosen for. */
  const [chosen, setChosen] = useState<{ recognition: UrlRecognition; settings: CollectionPolicy } | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    input.current?.focus();
  }, []);

  // A switch to the other dialog recognizes the kept address again.
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
  }, [url, mode]);

  async function perform(action: RecognitionAction, found: UrlRecognition): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const settings = chosen?.recognition === found ? chosen.settings : found.settings;
      onDone(await api.performAction(action.id === 'subscribe' && settings
        ? { ...action, request: { ...action.request, body: { ...action.request.body, settings } } }
        : action));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '操作失敗，請稍後再試。');
      setBusy(false);
    }
  }

  function switchMode(next: AddMode): void {
    setMode(next);
    setChosen(null);
    input.current?.focus();
  }

  const answer = currentRecognition(recognition.state === 'done' ? recognition : null, url);
  const found = answer?.recognition ?? null;
  const mismatch = found ? addMismatch(mode, found) : null;
  const unsupported = found !== null && !mismatch && isUnsupportedUrl(found);
  const primary = !mismatch && !unsupported ? answer?.primary ?? null : null;
  const fields = sourceTypes.find((type) => type.id === found?.sourceType)?.settings ?? [];
  const settings = found && chosen?.recognition === found ? chosen.settings : found?.settings ?? null;
  const primaryLabel = mode === 'url' ? '加入' : primary?.id === 'resume' ? '恢復訂閱' : '訂閱';

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (primary && found && !busy) void perform(primary, found);
  }

  return <dialog ref={dialog} className="add-dialog" aria-labelledby="add-dialog-title" data-testid="add-dialog"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <form className="add-body" onSubmit={submit}>
      <div className="dialog-titlebar">
        <h2 id="add-dialog-title" data-testid="add-dialog-title">{ADD_DIALOG_TITLES[mode]}</h2>
        <button type="button" className="icon-only close-button" aria-label="關閉" onClick={onClose}><Icon name="close" /></button>
      </div>
      <label className="field-label" htmlFor="add-url">網址</label>
      <input ref={input} id="add-url" className="url-input" type="text" inputMode="url" value={url} autoComplete="off" spellCheck={false}
        placeholder={PLACEHOLDERS[mode]} onChange={(event) => setUrl(event.target.value)} data-testid="add-url" />

      {recognition.state === 'recognizing' ? <p className="add-status" role="status"><span className="spinner" aria-hidden="true" />正在辨識網址…</p> : null}
      {recognition.state === 'error' ? <p className="add-problem" role="alert">{recognition.message}</p> : null}
      {mismatch ? <div className="add-mismatch" role="alert" data-testid="add-mismatch">
        <p>{mismatch.message}</p>
        <button type="button" className="button small" onClick={() => switchMode(mismatch.switchTo)} data-testid="add-switch">{mismatch.action}</button>
      </div> : null}
      {unsupported ? <p className="add-problem" role="alert" data-testid="add-unsupported">{UNSUPPORTED_URL}</p> : null}
      {found && !mismatch && !unsupported ? <RecognitionCard recognition={found} fields={fields} settings={settings} disabled={busy}
        onSettings={(patch) => setChosen({ recognition: found, settings: { ...settings!, ...patch } })} onOpenSource={onOpenSource} /> : null}
      {failure ? <p className="add-problem" role="alert">{failure}</p> : null}

      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button type="submit" className="button primary" disabled={busy || !primary} data-testid="add-confirm">{busy ? '處理中…' : primaryLabel}</button>
      </div>
    </form>
  </dialog>;
}

function RecognitionCard({ recognition, fields, settings, disabled, onSettings, onOpenSource }: {
  recognition: UrlRecognition;
  fields: SourceSettingField[];
  /** The settings a new subscription will start with. */
  settings: CollectionPolicy | null;
  disabled: boolean;
  onSettings: (patch: Partial<CollectionPolicy>) => void;
  onOpenSource: (type: string, id: string) => void;
}) {
  if (recognition.status === 'unsupported' || recognition.status === 'unavailable') {
    return <div className="recognition-card problem" role="alert" data-testid="recognition-card">
      <p className="card-kind">{recognition.status === 'unsupported' ? '無法加入這個網址' : `無法讀取${recognition.kindLabel ?? '這個網址'}`}</p>
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
  return <div className="recognition-card" data-testid="recognition-card">
    <span className="avatar" aria-hidden="true">{initials(target.title ?? '')}</span>
    <div className="card-main">
      <p className="card-kind"><Icon name={recognition.sourceType ?? 'file'} size={14} />{recognition.kindLabel}</p>
      <p className="card-title">{target.title}{subscription ? <span className={`status-chip ${subscription.enabled ? 'tracking' : 'paused'}`}>{subscription.enabled ? '已訂閱' : '已暫停'}</span> : null}</p>
      {!subscription && settings ? <>
        <p data-testid="subscribe-summary">{subscribeSummary(settings, recognition.autoCollection !== false)}</p>
        <div className="card-settings">
          <CollectionSettingsFields idPrefix="add-settings" fields={fields} value={settings} onChange={onSettings}
            disabled={disabled} />
        </div>
      </> : null}
      {subscription?.enabled ? <p>已訂閱這個頻道。<button type="button" className="inline-link" onClick={() => onOpenSource(recognition.sourceType!, subscription.id)}>查看訂閱</button></p> : null}
      {subscription && !subscription.enabled ? <p data-testid="resume-summary">{resumeSummary(subscription.settings)}</p> : null}
    </div>
  </div>;
}

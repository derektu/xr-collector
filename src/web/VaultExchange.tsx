import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ImportChoice, ImportConflict, ImportMode, ImportPreview, TransferResult, TransferStatus } from '../core/types.js';
import { api, ApiError } from './api-client.js';
import {
  conflictKind, countsText, lastSyncLabel, progressText, sideText, sizeLabel, situationText, sourceText, transferRunning,
  unregisteredText,
} from './transfer-presentation.js';

const POLL_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

type Open = { kind: 'export'; file?: { path: string; overwrite: boolean } } | { kind: 'import'; file?: string };

/**
 * Export and import of the active Vault, in the Vault section of Settings. An export file carries
 * the Vault to another machine and back, and doubles as a backup. In the desktop app files are
 * chosen with the system dialogs, which start in the export folder; in a browser the dialogs take
 * absolute paths on this computer.
 */
export function ExchangeActions({ onChanged }: { onChanged: (message: string) => void }) {
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const desktop = window.xrCollectorDesktop;

  useEffect(() => {
    if (open) return;
    api.vaultTransferStatus().then(setStatus).catch(() => undefined);
  }, [open]);

  async function choose(kind: Open['kind']): Promise<void> {
    setProblem(null);
    if (!desktop) { setOpen({ kind }); return; }
    try {
      if (kind === 'export') {
        const file = await desktop.chooseExportFile();
        if (file) setOpen({ kind, file });
      } else {
        const file = await desktop.chooseImportFile();
        if (file) setOpen({ kind, file });
      }
    } catch (error) {
      setProblem(`無法開啟檔案選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  return <>
    <div className="settings-line" data-testid="vault-exchange">
      <button type="button" className="button" onClick={() => void choose('export')} data-testid="vault-export">匯出…</button>
      <button type="button" className="button" onClick={() => void choose('import')} data-testid="vault-import">匯入…</button>
    </div>
    <p className="hint" data-testid="vault-last-sync">{lastSyncLabel(status?.lastSync ?? null)}</p>
    {problem ? <p className="add-problem" role="alert">{problem}</p> : null}
    {open?.kind === 'export' ? <ExportDialog file={open.file} onClose={() => setOpen(null)} /> : null}
    {open?.kind === 'import' ? <ImportDialog file={open.file}
      onClose={(imported) => { setOpen(null); if (imported) onChanged('匯入完成。'); }} /> : null}
  </>;
}

/** A modal dialog that cannot be dismissed with Escape while `busy`. */
export function Modal({ title, wide, busy, onDismiss, children, testId }: {
  title: string; wide?: boolean; busy: boolean; onDismiss: () => void; children: ReactNode; testId: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className={wide ? 'confirm-dialog transfer-dialog wide' : 'confirm-dialog transfer-dialog'}
    aria-labelledby={`${testId}-title`} data-testid={testId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onDismiss(); }}>
    <h2 id={`${testId}-title`}>{title}</h2>
    {children}
  </dialog>;
}

export interface TransferProgress {
  text: string;
  /** The transfer still waits for collection steps and can be cancelled. */
  waiting: boolean;
}

/** Progress of the running transfer, read from the status while `active`. */
export function useTransferProgress(active: boolean): TransferProgress {
  const [progress, setProgress] = useState<TransferProgress>({ text: '', waiting: false });
  useEffect(() => {
    if (!active) { setProgress({ text: '', waiting: false }); return undefined; }
    let alive = true;
    void (async () => {
      while (alive) {
        try {
          const status = await api.vaultTransferStatus();
          if (alive && transferRunning(status)) setProgress({ text: progressText(status), waiting: status.state === 'waiting' });
        } catch { /* the request in flight reports its own failure */ }
        await sleep(POLL_MS);
      }
    })();
    return () => { alive = false; };
  }, [active]);
  return progress;
}

export async function followTransfer(): Promise<TransferStatus> {
  for (;;) {
    const status = await api.vaultTransferStatus();
    if (!transferRunning(status)) return status;
    await sleep(POLL_MS);
  }
}

/** The progress line; while the transfer waits for collection steps it offers to cancel. */
export function Progress({ progress, fallback }: { progress: TransferProgress; fallback: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  async function cancel(): Promise<void> {
    setProblem(null);
    try { await api.cancelTransfer(); } catch (error) { setProblem(errorText(error, '無法取消。')); }
  }
  return <>
    <div className="transfer-progress-line">
      <p className="transfer-progress" role="status" data-testid="transfer-progress"><span className="spinner" aria-hidden="true" />{progress.text || fallback}</p>
      {progress.waiting ? <button type="button" className="button small" onClick={() => void cancel()} data-testid="transfer-cancel">取消</button> : null}
    </div>
    {problem ? <p className="add-problem" role="alert">{problem}</p> : null}
  </>;
}

export function PathField({ label, value, onChange, testId, hint }: {
  label: string; value: string; onChange: (value: string) => void; testId: string; hint?: string;
}) {
  return <label className="path-field">
    <span className="field-label">{label}</span>
    <input className="url-input" value={value} spellCheck={false} onChange={(event) => onChange(event.target.value)} data-testid={testId} />
    {hint ? <span className="field-hint">{hint}</span> : null}
  </label>;
}

function ExportDialog({ file, onClose }: { file: { path: string; overwrite: boolean } | undefined; onClose: () => void }) {
  const [target, setTarget] = useState(file?.path ?? '');
  const [phase, setPhase] = useState<'input' | 'running' | 'exists' | 'done' | 'failed'>(file ? 'running' : 'input');
  const [result, setResult] = useState<TransferResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'running');
  const started = useRef(false);
  const chosen = useRef('');

  useEffect(() => {
    if (file) return;
    api.exportSuggestion().then((suggestion) => setTarget((current) => current || suggestion.path)).catch(() => undefined);
  }, [file]);

  async function run(path: string, overwrite: boolean): Promise<void> {
    chosen.current = path;
    setPhase('running');
    setFailure(null);
    try {
      const status = await api.exportVault(path, overwrite);
      setResult(status.result);
      setPhase('done');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'file_exists') { setPhase('exists'); return; }
      setFailure(errorText(error, '匯出失敗，請稍後再試。'));
      setPhase(file ? 'failed' : 'input');
    }
  }
  useEffect(() => {
    if (file && !started.current) { started.current = true; void run(file.path, file.overwrite); }
  }, [file]);

  return <Modal title="匯出知識庫" busy={phase === 'running'} onDismiss={onClose} testId="export-dialog">
    {phase === 'input' ? <>
      <p>匯出檔包含知識庫的文件、訂閱與各自的收集設定、自動收集開關及刪除紀錄，可以在另一台電腦匯入，也可以當作備份。知識庫資料夾裡的其他檔案、搜尋索引、收集工作記錄與登入資料不包含在內。</p>
      <PathField label="匯出檔位置" value={target} onChange={setTarget} testId="export-path" hint="完整路徑，檔名以 .zip 結尾。" />
    </> : null}
    {phase === 'running' ? <Progress progress={progress} fallback="處理中…" /> : null}
    {phase === 'exists' ? <div data-testid="export-exists">
      <p>這個位置已經有同名的檔案：</p>
      <code className="setting-path">{chosen.current}</code>
      <p>要用目前的知識庫取代它嗎？原本的檔案內容會被覆寫。</p>
    </div> : null}
    {phase === 'done' && result ? <>
      <p className="transfer-done" role="status">已匯出。</p>
      <code className="setting-path" data-testid="export-result-path">{result.exportPath}</code>
      {result.exportBytes !== undefined ? <p className="hint">{sizeLabel(result.exportBytes)}</p> : null}
      {result.unregisteredFiles ? <p className="hint" data-testid="export-unregistered">{unregisteredText(result.unregisteredFiles)}</p> : null}
      <p className="hint">在另一台電腦以「匯入…」選擇這個檔案。</p>
    </> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button type="button" className="button primary" disabled={!target.trim()} onClick={() => void run(target.trim(), false)} data-testid="export-confirm">匯出</button>
      </> : null}
      {phase === 'exists' ? <>
        <button type="button" className="button" onClick={() => { if (file) onClose(); else setPhase('input'); }} data-testid="export-keep">取消</button>
        <button type="button" className="button primary" onClick={() => void run(chosen.current, true)} data-testid="export-replace">取代</button>
      </> : null}
      {phase === 'done' || phase === 'failed' ? <button type="button" className="button primary" onClick={onClose} data-testid="transfer-close">完成</button> : null}
    </div>
  </Modal>;
}

function ConflictRow({ conflict, choice, onChoice }: {
  conflict: ImportConflict; choice: ImportChoice | undefined; onChoice: (choice: ImportChoice) => void;
}) {
  return <li className="merge-row conflict" data-testid="import-conflict" data-key={conflict.key}>
    <div className="merge-row-main">
      <span className="merge-state conflict">{conflictKind(conflict)}</span>
      <span className="merge-name">{conflict.label}</span>
    </div>
    <ul className="merge-sides">
      <li>{sideText('本機', conflict.local)}</li>
      <li>{sideText('匯入檔', conflict.incoming)}</li>
    </ul>
    <div className="segmented merge-choice" role="radiogroup" aria-label={`${conflict.label}的處理方式`}>
      {([['local', '保留本機'], ['incoming', '採用匯入檔']] as const).map(([value, label]) => <button key={value} type="button" role="radio"
        aria-checked={choice === value} className={choice === value ? 'active' : undefined} onClick={() => onChoice(value)}>{label}</button>)}
    </div>
  </li>;
}

type ImportPhase = 'input' | 'comparing' | 'preview' | 'conflicts' | 'replace' | 'applying' | 'done';

function ImportDialog({ file, onClose }: { file: string | undefined; onClose: (imported: boolean) => void }) {
  const [source, setSource] = useState(file ?? '');
  const [phase, setPhase] = useState<ImportPhase>(file ? 'comparing' : 'input');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({});
  const [result, setResult] = useState<TransferStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'comparing' || phase === 'applying');
  const started = useRef(false);

  useEffect(() => {
    if (file) return;
    api.exportSuggestion().then((suggestion) => setSource((current) => current || `${suggestion.folder}/`)).catch(() => undefined);
  }, [file]);

  async function compare(path: string): Promise<void> {
    setPhase('comparing');
    setFailure(null);
    try {
      const next = await api.previewImport(path);
      setPreview(next);
      setChoices({});
      setMode('merge');
      setPhase('preview');
    } catch (error) {
      setFailure(errorText(error, '無法讀取這個匯出檔。'));
      setPhase('input');
    }
  }
  useEffect(() => {
    if (file && !started.current) { started.current = true; void compare(file); }
  }, [file]);

  async function apply(how: ImportMode): Promise<void> {
    if (!preview) return;
    setPhase('applying');
    setFailure(null);
    try {
      await api.applyImport(preview.id, how, how === 'merge' ? choices : {});
      const status = await followTransfer();
      if (status.state === 'error') throw new Error(status.message);
      // Cancelled while waiting for collection: nothing was written and the comparison still holds.
      if (status.state === 'idle') { setFailure(status.message); setPhase('preview'); return; }
      setResult(status);
      setPhase('done');
    } catch (error) {
      setFailure(errorText(error, '匯入失敗。'));
      // A failed apply discards the comparison, so the file is compared again before another try.
      setPreview(null);
      setPhase('input');
    }
  }

  async function cancel(): Promise<void> {
    if (preview) await api.cancelImport(preview.id).catch(() => undefined);
    onClose(false);
  }

  const conflicts = preview?.conflicts ?? [];
  const missing = conflicts.filter((item) => !choices[item.key]).length;
  const chooseAll = (choice: ImportChoice) => setChoices(Object.fromEntries(conflicts.map((item) => [item.key, choice])));
  const next = () => {
    if (mode === 'replace') setPhase('replace');
    else if (conflicts.length) setPhase('conflicts');
    else void apply('merge');
  };
  const header = preview ? <p className="merge-source" data-testid="import-source">
    <span>{preview.package.fileName}</span><span className="hint">・{sourceText(preview.package)}</span>
  </p> : null;
  const done = result?.result;

  return <Modal title="匯入" wide busy={phase === 'comparing' || phase === 'applying'}
    onDismiss={() => { if (phase === 'done') onClose(true); else void cancel(); }} testId="import-dialog">
    {phase === 'input' ? <>
      <p>選擇另一台電腦（或這台電腦先前）匯出的檔案。匯入前會先比對，只有兩邊都改過的項目需要你決定。</p>
      <PathField label="匯出檔" value={source} onChange={setSource} testId="import-path" hint="完整路徑，例如另一台電腦匯出的 .zip 檔。" />
    </> : null}
    {phase === 'comparing' ? <Progress progress={progress} fallback="正在比對…" /> : null}
    {phase === 'preview' && preview ? <div data-testid={`import-${preview.situation}`}>
      {header}
      <p>{situationText(preview.situation)}</p>
      {preview.situation === 'incoming' ? <p className="merge-counts" data-testid="import-counts">{countsText(preview.incoming)}</p> : null}
      {preview.situation === 'both' || preview.situation === 'unrelated' ? <div className="import-options" role="radiogroup" aria-label="匯入方式">
        <label className={mode === 'merge' ? 'import-option active' : 'import-option'} data-testid="import-mode-merge">
          <input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
          <div><strong>合併</strong>
            <span>{preview.situation === 'unrelated'
              ? `只新增，不刪除：${countsText(preview.incoming)}。`
              : `匯入檔的變更直接套用：${countsText(preview.incoming)}。`}
            {conflicts.length ? `${conflicts.length} 項兩邊內容不同，需要選擇保留哪一邊。` : '沒有需要選擇的項目。'}</span></div>
        </label>
        <label className={mode === 'replace' ? 'import-option active' : 'import-option'} data-testid="import-mode-replace">
          <input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          <div><strong>完全以匯入內容取代</strong>
            <span>知識庫會變得與匯入檔相同，失去本機 {preview.replaceLoses} 項變更。</span></div>
        </label>
      </div> : null}
      {preview.situation === 'nothing' && preview.replaceLoses > 0 ? <p className="hint import-secondary">
        本機有 {preview.replaceLoses} 項內容與匯入檔不同。如果是想回到匯入檔的內容（例如用匯入前自動匯出的檔案復原），可以改為完全以匯入內容取代。</p> : null}
      {preview.situation !== 'nothing' ? <ul className="fact-list">
        <li>在目前的知識庫原地套用，位置不變。</li>
        <li>套用前會先把目前的內容匯出到匯出資料夾，需要時可以再匯入回來。</li>
        <li>自動收集開關與各訂閱的收集進度維持本機。</li>
      </ul> : null}
    </div> : null}
    {phase === 'conflicts' && preview ? <>
      {header}
      <p>{conflicts.length} 項在兩邊的內容不同，請選擇要保留哪一邊。其餘變更會直接套用。</p>
      {conflicts.length > 1 ? <div className="merge-bulk">
        <button type="button" className="button small" onClick={() => chooseAll('local')}>全部保留本機</button>
        <button type="button" className="button small" onClick={() => chooseAll('incoming')}>全部採用匯入檔</button>
      </div> : null}
      <div className="merge-groups"><ul>{conflicts.map((conflict) => <ConflictRow key={conflict.key} conflict={conflict}
        choice={choices[conflict.key]} onChoice={(choice) => setChoices({ ...choices, [conflict.key]: choice })} />)}</ul></div>
    </> : null}
    {phase === 'replace' && preview ? <div data-testid="import-replace-confirm">
      {header}
      <p>知識庫的文件、訂閱與刪除紀錄會完全變成匯入檔的內容，本機 {preview.replaceLoses} 項不同的內容會被取代或移除。</p>
      <ul className="fact-list">
        <li>套用前會先把目前的內容匯出到匯出資料夾，需要時可以再匯入回來。</li>
        <li>自動收集開關與各訂閱的收集進度維持本機；知識庫資料夾裡不屬於知識庫的檔案不受影響。</li>
      </ul>
    </div> : null}
    {phase === 'applying' ? <Progress progress={progress} fallback="正在匯入…" /> : null}
    {phase === 'done' && result && done ? <div data-testid="import-done">
      <p className="transfer-done" role="status">{done.importMode === 'replace' ? '已完全以匯入內容取代。' : '匯入完成。'}</p>
      {done.imported ? <p className="merge-counts">{countsText(done.imported)}</p> : null}
      {done.preImportExportPath ? <><p>匯入前的內容已匯出到：</p><code className="setting-path" data-testid="import-backup-path">{done.preImportExportPath}</code></> : null}
    </div> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!source.trim()} onClick={() => void compare(source.trim())} data-testid="import-compare">比對</button>
      </> : null}
      {phase === 'preview' && preview?.situation === 'nothing' ? <>
        {preview.replaceLoses > 0 ? <button type="button" className="button" onClick={() => { setMode('replace'); setPhase('replace'); }}
          data-testid="import-replace-instead">改為完全以匯入內容取代…</button> : null}
        <button type="button" className="button primary" onClick={() => void cancel()} data-testid="import-close">完成</button>
      </> : null}
      {phase === 'preview' && preview?.situation === 'incoming' ? <>
        <button type="button" className="button" onClick={() => void cancel()} data-testid="import-cancel">取消</button>
        <button type="button" className="button primary" onClick={() => void apply('merge')} data-testid="import-confirm">匯入</button>
      </> : null}
      {phase === 'preview' && (preview?.situation === 'both' || preview?.situation === 'unrelated') ? <>
        <button type="button" className="button" onClick={() => void cancel()} data-testid="import-cancel">取消</button>
        <button type="button" className="button primary" onClick={next} data-testid="import-next">
          {mode === 'replace' ? '下一步' : conflicts.length ? '選擇衝突項目' : '匯入'}</button>
      </> : null}
      {phase === 'conflicts' ? <>
        {missing ? <span className="hint merge-missing">還有 {missing} 項尚未選擇</span> : null}
        <button type="button" className="button" onClick={() => setPhase('preview')} data-testid="import-back">上一步</button>
        <button type="button" className="button primary" disabled={missing > 0} onClick={() => void apply('merge')} data-testid="import-confirm">匯入</button>
      </> : null}
      {phase === 'replace' ? <>
        <button type="button" className="button" onClick={() => setPhase('preview')} data-testid="import-back">返回</button>
        <button type="button" className="button danger" onClick={() => void apply('replace')} data-testid="import-replace-confirm-button">取代</button>
      </> : null}
      {phase === 'done' ? <button type="button" className="button primary" onClick={() => onClose(true)} data-testid="transfer-close">完成</button> : null}
    </div>
  </Modal>;
}

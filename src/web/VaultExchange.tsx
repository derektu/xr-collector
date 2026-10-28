import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ImportMode, ImportPreview, TransferResult, TransferStatus } from '../core/types.js';
import { api, ApiError } from './api-client.js';
import {
  changeText, hasChanges, localNewerText, progressText, removalText, revealLabel, sourceText, transferRunning,
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
  const [open, setOpen] = useState<Open | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const desktop = window.xrCollectorDesktop;

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
    <div className="settings-line vault-exchange-actions" data-testid="vault-exchange">
      <button type="button" className="button" onClick={() => void choose('import')} data-testid="vault-import">匯入…</button>
      <button type="button" className="button" onClick={() => void choose('export')} data-testid="vault-export">匯出…</button>
    </div>
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
  const desktop = window.xrCollectorDesktop;

  async function reveal(): Promise<void> {
    setFailure(null);
    try { await desktop?.revealExport(); } catch (error) { setFailure(errorText(error, '無法開啟資料夾。')); }
  }

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
      <PathField label="匯出檔位置" value={target} onChange={setTarget} testId="export-path" hint="完整路徑，檔名以 .zip 結尾。" />
    </> : null}
    {phase === 'running' ? <Progress progress={progress} fallback="處理中…" /> : null}
    {phase === 'exists' ? <div data-testid="export-exists">
      <p>已有同名檔案，要覆蓋嗎？</p>
      <code className="setting-path">{chosen.current}</code>
    </div> : null}
    {phase === 'done' && result ? <>
      <p className="transfer-done" role="status">匯出完成。</p>
      <code className="setting-path" data-testid="export-result-path">{result.exportPath}</code>
    </> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button type="button" className="button primary" disabled={!target.trim()} onClick={() => void run(target.trim(), false)} data-testid="export-confirm">匯出</button>
      </> : null}
      {phase === 'exists' ? <>
        <button type="button" className="button" onClick={() => { if (file) onClose(); else setPhase('input'); }} data-testid="export-keep">取消</button>
        <button type="button" className="button primary" onClick={() => void run(chosen.current, true)} data-testid="export-replace">覆蓋</button>
      </> : null}
      {phase === 'done' && desktop ? <button type="button" className="button" onClick={() => void reveal()} data-testid="export-reveal">{revealLabel(desktop.platform)}</button> : null}
      {phase === 'done' || phase === 'failed' ? <button type="button" className="button primary" onClick={onClose} data-testid="transfer-close">完成</button> : null}
    </div>
  </Modal>;
}

type ImportPhase = 'input' | 'comparing' | 'preview' | 'replace' | 'applying' | 'done';

function ImportDialog({ file, onClose }: { file: string | undefined; onClose: (imported: boolean) => void }) {
  const [source, setSource] = useState(file ?? '');
  const [phase, setPhase] = useState<ImportPhase>(file ? 'comparing' : 'input');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [result, setResult] = useState<TransferStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
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
      await api.applyImport(preview.id, how);
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

  /**
   * Closes a comparison with nothing to show. When the merge still has deletion records to write, it
   * applies the merge first, keeping the screen as it is, so those videos stay deleted on this Vault.
   */
  async function finish(): Promise<void> {
    if (!preview?.mergeRecords) { await cancel(); return; }
    setRecording(true);
    setFailure(null);
    try {
      await api.applyImport(preview.id, 'merge');
      const status = await followTransfer();
      if (status.state === 'error') throw new Error(status.message);
      if (status.state === 'idle') { setFailure(status.message); return; }
      onClose(true);
    } catch (error) {
      setFailure(errorText(error, '匯入失敗。'));
      setPreview(null);
      setPhase('input');
    } finally {
      setRecording(false);
    }
  }

  async function cancel(): Promise<void> {
    if (preview) await api.cancelImport(preview.id).catch(() => undefined);
    onClose(false);
  }

  const exported = preview ? sourceText(preview.package) : null;
  const header = preview ? <p className="merge-source" data-testid="import-source">
    <span>{preview.package.fileName}</span>{exported ? <span className="hint">・{exported}</span> : null}
  </p> : null;
  const mergeable = !!preview && hasChanges(preview.merge);
  const replaceable = !!preview && preview.localNewer > 0;
  const removal = preview ? removalText(preview.replace) : null;
  const done = result?.result;

  return <Modal title="匯入" wide busy={phase === 'comparing' || phase === 'applying' || recording}
    onDismiss={() => { if (phase === 'done') onClose(true); else void cancel(); }} testId="import-dialog">
    {phase === 'input' ? <>
      <PathField label="匯出檔" value={source} onChange={setSource} testId="import-path" hint="完整路徑，例如另一台電腦匯出的 .zip 檔。" />
    </> : null}
    {phase === 'comparing' ? <Progress progress={progress} fallback="正在比對…" /> : null}
    {phase === 'preview' && preview && mergeable ? <div data-testid="import-preview">
      {header}
      <p className="merge-counts" data-testid="import-counts">{changeText(preview.merge)}</p>
      <div className="import-options" role="radiogroup" aria-label="匯入方式">
        <label className={mode === 'merge' ? 'import-option active' : 'import-option'} data-testid="import-mode-merge">
          <input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
          <div><strong>合併</strong></div>
        </label>
        <label className={mode === 'replace' ? 'import-option active' : 'import-option'} data-testid="import-mode-replace">
          <input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          <div><strong>完全取代</strong>{mode === 'replace' && removal ? <span data-testid="import-replace-removal">{removal}</span> : null}</div>
        </label>
      </div>
    </div> : null}
    {phase === 'preview' && preview && !mergeable ? <div data-testid="import-nothing">
      {header}
      <p>沒有需要匯入的內容</p>
      {preview.localNewer ? <p className="hint" data-testid="import-local-newer">{localNewerText(preview.localNewer)}</p> : null}
    </div> : null}
    {phase === 'replace' && preview ? <div data-testid="import-replace-confirm">
      {header}
      <p className="merge-counts" data-testid="import-replace-counts">{changeText(preview.replace)}</p>
    </div> : null}
    {phase === 'applying' ? <Progress progress={progress} fallback="正在匯入…" /> : null}
    {phase === 'done' && result && done ? <div data-testid="import-done">
      <p className="transfer-done" role="status">匯入完成。</p>
      {done.imported ? <p className="merge-counts">{changeText(done.imported)}</p> : null}
      {done.searchRebuildNeeded ? <p className="add-problem" role="alert" data-testid="import-search-stale">
        搜尋索引需要重建：到設定按「重建索引」。</p> : null}
    </div> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!source.trim()} onClick={() => void compare(source.trim())} data-testid="import-compare">比對</button>
      </> : null}
      {phase === 'preview' && !mergeable ? <>
        {replaceable ? <button type="button" className="button" disabled={recording} onClick={() => setPhase('replace')}
          data-testid="import-replace-instead">完全取代…</button> : null}
        <button type="button" className="button primary" disabled={recording} onClick={() => void finish()} data-testid="import-close">完成</button>
      </> : null}
      {phase === 'preview' && mergeable ? <>
        <button type="button" className="button" onClick={() => void cancel()} data-testid="import-cancel">取消</button>
        {mode === 'merge'
          ? <button type="button" className="button primary" onClick={() => void apply('merge')} data-testid="import-confirm">匯入</button>
          : <button type="button" className="button primary" onClick={() => setPhase('replace')} data-testid="import-next">下一步</button>}
      </> : null}
      {phase === 'replace' ? <>
        <button type="button" className="button" onClick={() => setPhase('preview')} data-testid="import-back">返回</button>
        <button type="button" className="button danger" onClick={() => void apply('replace')} data-testid="import-replace-confirm-button">取代</button>
      </> : null}
      {phase === 'done' ? <button type="button" className="button primary" onClick={() => onClose(true)} data-testid="transfer-close">完成</button> : null}
    </div>
  </Modal>;
}

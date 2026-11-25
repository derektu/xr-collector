import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ExportSuggestion, ImportMode, ImportPreview, TransferResult, TransferStatus } from '../../shared/vault/vault-types.js';
import { api } from './api-client.js';
import { ApiError } from './api-error.js';
import { readUntil } from './read-until.js';
import { changeHub, useLiveRead } from './use-changes.js';
import {
  changeText, hasChanges, importApplyOutcome, localNewerText, progressText, revealLabel, sourceText, transferRunning,
  type ImportApplyOutcome,
} from './transfer-presentation.js';

export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

type Open = { kind: 'export'; file?: { path: string; overwriteConfirmed: boolean } } | { kind: 'import'; file?: string };

export function ExchangeActions({ onNotice }: { onNotice: (message: string) => void }) {
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
      onClose={(imported) => { setOpen(null); if (imported) onNotice('匯入完成。'); }} /> : null}
  </>;
}

export function Modal({ title, width, busy, onDismiss, children, testId }: {
  title: string; width?: 'form' | 'wide'; busy: boolean; onDismiss: () => void; children: ReactNode; testId: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className={width ? `confirm-dialog transfer-dialog ${width}` : 'confirm-dialog transfer-dialog'}
    aria-labelledby={`${testId}-title`} data-testid={testId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onDismiss(); }}>
    <h2 id={`${testId}-title`}>{title}</h2>
    {children}
  </dialog>;
}

export function useTransferProgress(active: boolean): string {
  const { value: status } = useLiveRead(['transfer'], (signal) => api.vaultTransferStatus(signal), [], { enabled: active });
  return active && status && transferRunning(status) ? progressText(status) : '';
}

export function followTransfer(): Promise<TransferStatus> {
  return readUntil(changeHub, () => api.vaultTransferStatus(), (status) => !transferRunning(status), (change) => change.kind === 'vault');
}

export function Progress({ progress, fallback }: { progress: string; fallback: string }) {
  return <p className="transfer-progress" role="status" data-testid="transfer-progress"><span className="spinner" aria-hidden="true" />{progress || fallback}</p>;
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

type PathInput = { loaded: false } | { loaded: true; path: string };

function useSuggestedPath(given: string | undefined, pick: (suggestion: ExportSuggestion) => string): [PathInput, (path: string) => void] {
  const [input, setInput] = useState<PathInput>(given === undefined ? { loaded: false } : { loaded: true, path: given });
  useEffect(() => {
    if (given !== undefined) return;
    api.exportSuggestion().then((suggestion) => setInput({ loaded: true, path: pick(suggestion) }))
      .catch(() => setInput({ loaded: true, path: '' }));
  }, [given]);
  return [input, (path) => setInput({ loaded: true, path })];
}

function ExportDialog({ file, onClose }: { file: { path: string; overwriteConfirmed: boolean } | undefined; onClose: () => void }) {
  const [target, setTarget] = useSuggestedPath(file?.path, (suggestion) => suggestion.path);
  const [phase, setPhase] = useState<'input' | 'running' | 'exists' | 'done' | 'failed'>(file ? 'running' : 'input');
  const [result, setResult] = useState<TransferResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'running');
  const started = useRef(false);
  const chosen = useRef('');
  const desktop = window.xrCollectorDesktop;

  async function reveal(): Promise<void> {
    setFailure(null);
    try { await desktop?.revealTransferFile(); } catch (error) { setFailure(errorText(error, '無法開啟資料夾。')); }
  }

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
    if (file && !started.current) { started.current = true; void run(file.path, file.overwriteConfirmed); }
  }, [file]);

  return <Modal title="匯出知識庫" busy={phase === 'running'} onDismiss={onClose} testId="export-dialog">
    {phase === 'input' && target.loaded ? <>
      <PathField label="匯出檔位置" value={target.path} onChange={setTarget} testId="export-path" hint="完整路徑，檔名以 .zip 結尾。" />
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
        <button type="button" className="button primary" disabled={!target.loaded || !target.path.trim()}
          onClick={() => { if (target.loaded) void run(target.path.trim(), false); }} data-testid="export-confirm">匯出</button>
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

type FailedApply = Exclude<ImportApplyOutcome, { kind: 'imported' }> | { kind: 'unfollowed'; reason: string };

async function applyAndFollow(id: string, how: ImportMode): Promise<{ kind: 'imported'; status: TransferStatus } | FailedApply> {
  try {
    await api.applyImport(id, how);
  } catch (error) {
    return { kind: 'unchanged', reason: errorText(error, '') };
  }
  let status: TransferStatus;
  try {
    status = await followTransfer();
  } catch (error) {
    return { kind: 'unfollowed', reason: errorText(error, '無法讀取匯入進度。') };
  }
  const outcome = importApplyOutcome(status);
  return outcome.kind === 'imported' ? { kind: 'imported', status } : outcome;
}

type ImportPhase = 'input' | 'comparing' | 'preview' | 'applying' | 'done' | 'partial';

function ImportDialog({ file, onClose }: { file: string | undefined; onClose: (imported: boolean) => void }) {
  const [source, setSource] = useSuggestedPath(file, (suggestion) => `${suggestion.folder}/`);
  const [phase, setPhase] = useState<ImportPhase>(file ? 'comparing' : 'input');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [result, setResult] = useState<TransferStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'comparing' || phase === 'applying');
  const started = useRef(false);
  const desktop = window.xrCollectorDesktop;

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

  function showFailedApply(failed: FailedApply): void {
    setPreview(null);
    if (failed.kind === 'partial') { setBackupPath(failed.backupPath); setPhase('partial'); return; }
    setFailure(failed.kind === 'unchanged' ? `匯入失敗，知識庫未變更。${failed.reason}` : failed.reason);
    setPhase('input');
  }

  async function reveal(): Promise<void> {
    setFailure(null);
    try { await desktop?.revealTransferFile(); } catch (error) { setFailure(errorText(error, '無法開啟資料夾。')); }
  }

  async function apply(how: ImportMode): Promise<void> {
    if (!preview) return;
    setPhase('applying');
    setFailure(null);
    const applied = await applyAndFollow(preview.id, how);
    if (applied.kind !== 'imported') { showFailedApply(applied); return; }
    setResult(applied.status);
    setPhase('done');
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
  const choosing = mergeable || mode === 'replace';
  const chosen = preview ? preview[mode] : null;
  const done = result?.result;

  return <Modal title="匯入" width="wide" busy={phase === 'comparing' || phase === 'applying'}
    onDismiss={() => { if (phase === 'done') onClose(true); else if (phase === 'partial') onClose(false); else void cancel(); }} testId="import-dialog">
    {phase === 'input' && source.loaded ? <>
      <PathField label="匯出檔" value={source.path} onChange={setSource} testId="import-path" hint="完整路徑，例如另一台電腦匯出的 .zip 檔。" />
    </> : null}
    {phase === 'comparing' ? <Progress progress={progress} fallback="正在比對…" /> : null}
    {phase === 'preview' && preview && chosen && choosing ? <div data-testid="import-preview">
      {header}
      <p className="merge-counts" data-testid="import-counts"
        data-documents-removed={chosen.documents.removed} data-subscriptions-removed={chosen.subscriptions.removed}>{changeText(chosen)}</p>
      <div className="import-options" role="radiogroup" aria-label="匯入方式">
        <label className={mode === 'merge' ? 'import-option active' : 'import-option'} data-testid="import-mode-merge">
          <input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
          <div><strong>合併</strong></div>
        </label>
        <label className={mode === 'replace' ? 'import-option active' : 'import-option'} data-testid="import-mode-replace">
          <input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          <div><strong>完全取代</strong></div>
        </label>
      </div>
    </div> : null}
    {phase === 'preview' && preview && !choosing ? <div data-testid="import-nothing">
      {header}
      <p>沒有需要匯入的內容</p>
      {preview.localNewer ? <p className="hint" data-testid="import-local-newer">{localNewerText(preview.localNewer)}</p> : null}
    </div> : null}
    {phase === 'applying' ? <Progress progress={progress} fallback="正在匯入…" /> : null}
    {phase === 'done' && result && done ? <div data-testid="import-done">
      <p className="transfer-done" role="status">匯入完成。</p>
      {done.imported ? <p className="merge-counts">{changeText(done.imported)}</p> : null}
    </div> : null}
    {phase === 'partial' && backupPath ? <div data-testid="import-partial">
      <p className="add-problem" role="alert">匯入未完成，部分內容已更新。用匯入前的備份以「完全取代」匯入即可還原。</p>
      <code className="setting-path" data-testid="import-backup-path">{backupPath}</code>
    </div> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!source.loaded || !source.path.trim()}
          onClick={() => { if (source.loaded) void compare(source.path.trim()); }} data-testid="import-compare">比對</button>
      </> : null}
      {phase === 'preview' && !choosing ? <>
        {replaceable ? <button type="button" className="button" onClick={() => setMode('replace')}
          data-testid="import-replace-instead">完全取代…</button> : null}
        <button type="button" className="button primary" onClick={() => void cancel()} data-testid="import-close">完成</button>
      </> : null}
      {phase === 'preview' && choosing ? <>
        <button type="button" className="button" onClick={() => void cancel()} data-testid="import-cancel">取消</button>
        {mode === 'merge'
          ? <button type="button" className="button primary" onClick={() => void apply('merge')} data-testid="import-confirm">匯入</button>
          : <button type="button" className="button danger" onClick={() => void apply('replace')} data-testid="import-replace">取代</button>}
      </> : null}
      {phase === 'done' ? <button type="button" className="button primary" onClick={() => onClose(true)} data-testid="transfer-close">完成</button> : null}
      {phase === 'partial' ? <>
        {desktop ? <button type="button" className="button" onClick={() => void reveal()} data-testid="import-backup-reveal">顯示位置</button> : null}
        <button type="button" className="button primary" onClick={() => onClose(false)} data-testid="transfer-close">完成</button>
      </> : null}
    </div>
  </Modal>;
}

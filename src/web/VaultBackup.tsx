import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MergeChoice, MergeItem, MergePreview, TransferResult, TransferStatus } from '../core/types.js';
import { api, ApiError } from './api-client.js';
import { lineDiff } from './line-diff.js';
import {
  besideVault, choiceText, exportFileName, fileName, itemName, itemTimes, lastExportLabel, mergeCounts, mergeGroups,
  progressText, sizeLabel, transferRunning, unregisteredText,
} from './transfer-presentation.js';

const POLL_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

type Open =
  | { kind: 'export'; file?: { path: string; overwrite: boolean } }
  | { kind: 'merge'; file?: string }
  | { kind: 'restore'; file?: string };

/**
 * Settings section for backups: export the Vault, merge another backup into it, or restore a backup
 * as a new Vault. In the desktop app files are chosen with the system dialogs; in a browser the
 * dialogs take absolute paths on this computer.
 */
export function BackupSection({ vaultPath, activeJobs, onChanged }: {
  vaultPath: string;
  /** Collection jobs not yet finished; a restore names how many stop with the switch. */
  activeJobs: number;
  onChanged: (message: string) => void;
}) {
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
        const file = await desktop.chooseBackupToSave(besideVault(vaultPath, exportFileName(new Date())));
        if (file) setOpen({ kind, file });
      } else {
        const file = await desktop.chooseBackupToOpen();
        if (file) setOpen({ kind, file });
      }
    } catch (error) {
      setProblem(`無法開啟檔案選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  return <section className="settings-section" data-testid="settings-backup">
    <h2>備份與還原</h2>
    <div className="settings-line">
      <button type="button" className="button" onClick={() => void choose('export')} data-testid="backup-export">匯出備份</button>
      <button type="button" className="button" onClick={() => void choose('merge')} data-testid="backup-merge">合併另一份備份…</button>
      <button type="button" className="button" onClick={() => void choose('restore')} data-testid="backup-restore">從備份還原…</button>
    </div>
    <p className="hint" data-testid="backup-last-export">{lastExportLabel(status?.lastExportedAt ?? null)}</p>
    {problem ? <p className="add-problem" role="alert">{problem}</p> : null}
    {open?.kind === 'export' ? <ExportDialog vaultPath={vaultPath} file={open.file} onClose={() => setOpen(null)} /> : null}
    {open?.kind === 'merge' ? <MergeDialog file={open.file}
      onClose={(merged) => { setOpen(null); if (merged) onChanged('合併完成。'); }} /> : null}
    {open?.kind === 'restore' ? <RestoreDialog vaultPath={vaultPath} file={open.file} activeJobs={activeJobs}
      onClose={(switched) => { setOpen(null); if (switched) window.location.reload(); }} /> : null}
  </section>;
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

function ExportDialog({ vaultPath, file, onClose }: {
  vaultPath: string; file: { path: string; overwrite: boolean } | undefined; onClose: () => void;
}) {
  const [target, setTarget] = useState(() => file?.path ?? besideVault(vaultPath, exportFileName(new Date())));
  const [phase, setPhase] = useState<'input' | 'running' | 'exists' | 'done' | 'failed'>(file ? 'running' : 'input');
  const [result, setResult] = useState<TransferResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'running');
  const started = useRef(false);
  const chosen = useRef('');

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

  return <Modal title="匯出備份" busy={phase === 'running'} onDismiss={onClose} testId="export-dialog">
    {phase === 'input' ? <>
      <p>備份包含知識庫的文件、訂閱與各自的收集設定、收集進度、自動收集開關及刪除紀錄。知識庫資料夾裡的其他檔案、搜尋索引、收集工作記錄與登入資料不包含在內。</p>
      <PathField label="備份檔案位置" value={target} onChange={setTarget} testId="export-path" hint="完整路徑，檔名以 .xr-vault 結尾。" />
    </> : null}
    {phase === 'running' ? <Progress progress={progress} fallback="處理中…" /> : null}
    {phase === 'exists' ? <div data-testid="export-exists">
      <p>這個位置已經有同名的備份檔案：</p>
      <code className="setting-path">{chosen.current}</code>
      <p>要用目前的知識庫取代它嗎？原本的檔案內容會被覆寫。</p>
    </div> : null}
    {phase === 'done' && result ? <>
      <p className="transfer-done" role="status">備份已建立。</p>
      <code className="setting-path" data-testid="export-result-path">{result.exportPath}</code>
      {result.exportBytes !== undefined ? <p className="hint">{sizeLabel(result.exportBytes)}</p> : null}
      {result.unregisteredFiles ? <p className="hint" data-testid="export-unregistered">{unregisteredText(result.unregisteredFiles)}</p> : null}
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

function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  return <pre className="merge-diff" aria-label="本機與備份的差異">{lines.map((line, index) => <span key={index} className={`diff-${line.kind}`}>
    {line.kind === 'removed' ? '− ' : line.kind === 'added' ? '+ ' : '  '}{line.text}{'\n'}</span>)}</pre>;
}

function MergeRow({ item, choice, onChoice, disabled }: {
  item: MergeItem; choice: MergeChoice | undefined; onChoice: (choice: MergeChoice) => void; disabled: boolean;
}) {
  const text = choiceText(item);
  const [showDiff, setShowDiff] = useState(false);
  return <li className={item.state === 'conflict' ? 'merge-row conflict' : 'merge-row'} data-testid="merge-row" data-key={item.key}>
    <div className="merge-row-main">
      <span className={`merge-state ${item.state}`}>{item.state === 'conflict' ? '需要選擇' : '新增'}</span>
      <span className="merge-name">{itemName(item)}</span>
    </div>
    <p>{text.summary}</p>
    {item.state === 'conflict' ? <>
      <p className="hint">{itemTimes(item)}</p>
      <div className="segmented merge-choice" role="radiogroup" aria-label={`${itemName(item)}的處理方式`}>
        {(['local', 'incoming'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={choice === value}
          className={choice === value ? 'active' : undefined} disabled={disabled} onClick={() => onChoice(value)}>{text[value]}</button>)}
      </div>
      <button type="button" className="inline-link merge-diff-toggle" aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>
        {showDiff ? '隱藏差異' : '顯示差異'}</button>
      {showDiff ? <><p className="hint">− 本機內容　+ 備份內容</p><Diff before={item.localText} after={item.incomingText} /></> : null}
    </> : null}
  </li>;
}

function MergeDialog({ file, onClose }: { file: string | undefined; onClose: (merged: boolean) => void }) {
  const [source, setSource] = useState(file ?? '');
  const [phase, setPhase] = useState<'input' | 'comparing' | 'preview' | 'applying' | 'done'>(file ? 'comparing' : 'input');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [result, setResult] = useState<TransferResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'comparing' || phase === 'applying');
  const started = useRef(false);

  async function compare(path: string): Promise<void> {
    setPhase('comparing');
    setFailure(null);
    try {
      setPreview(await api.previewMerge(path));
      setChoices({});
      setPhase('preview');
    } catch (error) {
      setFailure(errorText(error, '無法比對這份備份。'));
      setPhase('input');
    }
  }
  useEffect(() => {
    if (file && !started.current) { started.current = true; void compare(file); }
  }, [file]);

  async function apply(): Promise<void> {
    if (!preview) return;
    setPhase('applying');
    setFailure(null);
    try {
      await api.applyMerge(preview.id, choices);
      const status = await followTransfer();
      if (status.state === 'error') throw new Error(status.message);
      // Cancelled while waiting for collection: nothing was written and the comparison still holds.
      if (status.state === 'idle') { setFailure(status.message); setPhase('preview'); return; }
      setResult(status.result);
      setPhase('done');
    } catch (error) {
      setFailure(errorText(error, '合併失敗。'));
      // A failed apply discards the comparison, so the backup is compared again before another try.
      setPreview(null);
      setPhase('input');
    }
  }

  async function cancel(): Promise<void> {
    if (preview) await api.cancelMerge(preview.id).catch(() => undefined);
    onClose(false);
  }

  const counts = preview ? mergeCounts(preview.items) : null;
  const conflicts = preview?.items.filter((item) => item.state === 'conflict') ?? [];
  const missing = conflicts.filter((item) => !choices[item.key]).length;
  const chooseAll = (choice: MergeChoice) => setChoices(Object.fromEntries(conflicts.map((item) => [item.key, choice])));

  return <Modal title="合併另一份備份" wide busy={phase === 'comparing' || phase === 'applying'}
    onDismiss={() => { if (phase === 'done') onClose(true); else void cancel(); }} testId="merge-dialog">
    {phase === 'input' ? <>
      <p>把另一份備份的內容加入目前的知識庫。合併前會先列出差異，兩邊不同的項目由你決定保留哪一邊。</p>
      <PathField label="備份檔案" value={source} onChange={setSource} testId="merge-path" hint="完整路徑，例如另一台電腦匯出的 .xr-vault 檔。" />
    </> : null}
    {phase === 'comparing' ? <Progress progress={progress} fallback="正在比對…" /> : null}
    {phase === 'preview' && preview && counts ? <>
      <p className="merge-source"><span>{fileName(source)}</span>{preview.package.exportedAt ? <span className="hint">・匯出於 {lastExportLabel(preview.package.exportedAt).replace('上次匯出 ', '')}</span> : null}</p>
      <p className="merge-counts" data-testid="merge-counts">新增 {counts.added}・相同 {counts.same}・需要選擇 {counts.conflicts}</p>
      <p>新增的項目會加入，相同的略過。備份裡沒有的項目保留本機，不會因此刪除。自動收集開關維持本機；既有訂閱的收集進度維持本機，新訂閱帶入備份中的進度。</p>
      {conflicts.length > 1 ? <div className="merge-bulk">
        <button type="button" className="button small" onClick={() => chooseAll('local')}>全部保留本機</button>
        <button type="button" className="button small" onClick={() => chooseAll('incoming')}>全部採用備份</button>
      </div> : null}
      <div className="merge-groups">
        {mergeGroups(preview.items).map((group) => <section key={group.kind} className="merge-group" data-testid={`merge-group-${group.kind}`}>
          <h3>{group.title}{group.same ? <span className="hint">相同 {group.same} 項</span> : null}</h3>
          {group.items.length ? <ul>{group.items.map((item) => <MergeRow key={item.key} item={item} choice={choices[item.key]} disabled={false}
            onChoice={(choice) => setChoices({ ...choices, [item.key]: choice })} />)}</ul> : null}
        </section>)}
      </div>
    </> : null}
    {phase === 'applying' ? <Progress progress={progress} fallback="正在合併…" /> : null}
    {phase === 'done' && result ? <>
      <p className="transfer-done" role="status">{result.writtenFiles ? `合併完成，寫入 ${result.writtenFiles} 個檔案。` : '合併完成，沒有需要寫入的變更。'}</p>
      {result.mergeBackupPath ? <><p>合併前的資料已另存一份備份：</p><code className="setting-path" data-testid="merge-backup-path">{result.mergeBackupPath}</code></> : null}
    </> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!source.trim()} onClick={() => void compare(source.trim())} data-testid="merge-compare">比對</button>
      </> : null}
      {phase === 'preview' ? <>
        {missing ? <span className="hint merge-missing">還有 {missing} 項尚未選擇</span> : null}
        <button type="button" className="button" onClick={() => void cancel()} data-testid="merge-cancel">取消</button>
        <button type="button" className="button primary" disabled={missing > 0} onClick={() => void apply()} data-testid="merge-confirm">合併</button>
      </> : null}
      {phase === 'done' ? <button type="button" className="button primary" onClick={() => onClose(true)} data-testid="transfer-close">完成</button> : null}
    </div>
  </Modal>;
}

function RestoreDialog({ vaultPath, file, activeJobs, onClose }: {
  vaultPath: string; file: string | undefined; activeJobs: number; onClose: (switched: boolean) => void;
}) {
  const desktop = window.xrCollectorDesktop;
  const [source, setSource] = useState(file ?? '');
  const [target, setTarget] = useState('');
  const [phase, setPhase] = useState<'input' | 'running' | 'done'>('input');
  const [result, setResult] = useState<{ status: TransferStatus; collecting: boolean } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [scheduleProblem, setScheduleProblem] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'running');

  useEffect(() => {
    api.restoreSuggestion().then((path) => setTarget((current) => current || path)).catch(() => undefined);
  }, []);

  async function chooseFolder(): Promise<void> {
    if (!desktop) return;
    try {
      const folder = await desktop.chooseDirectory(target || vaultPath);
      if (folder) setTarget(folder);
    } catch (error) {
      setFailure(`無法開啟資料夾選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  async function restore(): Promise<void> {
    setPhase('running');
    setFailure(null);
    try {
      await api.restoreVault(source.trim(), target.trim());
      const status = await followTransfer();
      if (status.state === 'error') throw new Error(status.message);
      if (status.state === 'idle') { setFailure(status.message); setPhase('input'); return; }
      setResult({ status, collecting: false });
      setPhase('done');
    } catch (error) {
      setFailure(errorText(error, '還原失敗。'));
      setPhase('input');
    }
  }

  async function resumeCollection(): Promise<void> {
    setScheduleProblem(null);
    try {
      await api.setAutoCollection(true);
      setResult((current) => current ? { ...current, collecting: true } : current);
    } catch (error) {
      setScheduleProblem(errorText(error, '無法開啟自動收集。'));
    }
  }

  const done = result?.status.result;
  return <Modal title="從備份還原" wide busy={phase === 'running'} onDismiss={() => onClose(phase === 'done')} testId="restore-dialog">
    {phase === 'input' ? <>
      {desktop && file ? <p className="merge-source"><span className="field-label">備份檔案</span><span>{fileName(source)}</span></p>
        : <PathField label="備份檔案" value={source} onChange={setSource} testId="restore-path" hint="完整路徑，例如 .xr-vault 備份檔。" />}
      <div className="path-row">
        <PathField label="新知識庫的位置" value={target} onChange={setTarget} testId="restore-target" hint="不存在或空的資料夾。" />
        {desktop ? <button type="button" className="button" onClick={() => void chooseFolder()} data-testid="restore-choose-folder">選擇位置…</button> : null}
      </div>
      <ul className="fact-list" data-testid="restore-facts">
        <li>在這個位置建立新的知識庫，完成後切換使用。</li>
        <li>目前的知識庫保留在 <code>{vaultPath}</code>，內容不會變更。</li>
        {activeJobs > 0 ? <li>目前有 {activeJobs} 個收集工作，切換時會暫停，回到原知識庫時接續。</li> : null}
        <li>新知識庫的自動收集會先暫停，完成後可以開啟。</li>
      </ul>
    </> : null}
    {phase === 'running' ? <Progress progress={progress} fallback="正在還原…" /> : null}
    {phase === 'done' && result && done ? <>
      <p className="transfer-done" role="status">已切換到還原的知識庫。</p>
      <code className="setting-path" data-testid="restore-result-path">{result.status.vaultPath}</code>
      <p>原知識庫保留在 <code>{done.previousVaultPath}</code>。{done.interruptedJobs ? `它的 ${done.interruptedJobs} 個收集工作已暫停，回到原知識庫時接續。` : ''}</p>
      <div className="restore-schedule" data-testid="restore-schedule">
        {result.collecting
          ? <p className="transfer-done">自動收集已開啟。</p>
          : <><p>自動收集已暫停。確認內容沒問題後再開啟，避免重複收集。</p>
            <button type="button" className="button" onClick={() => void resumeCollection()} data-testid="restore-resume-collection">開啟自動收集</button></>}
        {scheduleProblem ? <p className="add-problem" role="alert">{scheduleProblem}</p> : null}
      </div>
    </> : null}
    {failure ? <p className="add-problem" role="alert">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!source.trim() || !target.trim()} onClick={() => void restore()} data-testid="restore-confirm">還原並切換</button>
      </> : null}
      {phase === 'done' ? <button type="button" className="button primary" onClick={() => onClose(true)} data-testid="transfer-close">完成</button> : null}
    </div>
  </Modal>;
}

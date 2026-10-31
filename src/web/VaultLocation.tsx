import { useEffect, useRef, useState } from 'react';
import type { MoveCheck, TransferStatus } from '../core/types.js';
import { api } from './api-client.js';
import { errorText, ExchangeActions, followTransfer, Modal, PathField, Progress, useTransferProgress } from './VaultExchange.js';
import { useLiveRead } from './use-changes.js';
import { moveTargetIn, relocates, revealLabel, sizeLabel, transferRunning } from './transfer-presentation.js';

const CHECK_DELAY_MS = 350;

type Open = { kind: 'move' | 'open'; resume: boolean };

/**
 * A move or switch the person sent to the background. It outlives the Settings page, so returning to
 * Settings shows the outcome of the operation that ran while another page was open.
 */
let background: 'move' | 'open' | null = null;

/**
 * Settings section for the active Vault: where it is, what it holds, the actions that change where
 * the app reads it from (move it, or open another Vault), and its export and import. Moving and
 * opening are unavailable when the status names a reason, such as a location fixed at startup.
 */
export function VaultLocationSection({ vaultPath, activeJobs, counts, onChanged }: {
  vaultPath: string | null;
  /** Collection jobs not yet finished; switching Vaults names how many pause. */
  activeJobs: number;
  counts: { documents: number; sources: number } | null;
  onChanged: (message: string) => void;
}) {
  const desktop = window.xrCollectorDesktop;
  const [open, setOpen] = useState<Open | null>(null);
  // Follows the status while no dialog is open, so a move or switch running in the background shows its progress here.
  const { value: status } = useLiveRead(['transfer'], (signal) => api.vaultTransferStatus(signal), [], { enabled: !open });
  const [problem, setProblem] = useState<string | null>(null);
  const current = status?.vaultPath ?? vaultPath;
  const unavailable = status?.relocationUnavailable ?? null;
  const running = relocates(status) && transferRunning(status);

  /** The status read before the dialog went to the background; only a newer one can tell that the operation ended. */
  const shownBefore = useRef<TransferStatus | null>(null);
  useEffect(() => {
    if (open || !background || !status || status === shownBefore.current || !relocates(status) || transferRunning(status)) return;
    // The background operation ended: show its outcome in its own dialog.
    setOpen({ kind: background, resume: true });
    background = null;
  }, [status, open]);

  async function reveal(): Promise<void> {
    setProblem(null);
    try { await desktop?.revealVault(); } catch (error) { setProblem(errorText(error, '無法開啟資料夾。')); }
  }

  const close = (switched: boolean) => {
    setOpen(null);
    if (switched) window.location.reload();
  };

  return <section className="settings-section" data-testid="settings-vault">
    <h2>知識庫</h2>
    <code className="setting-path" data-testid="vault-path">{current}</code>
    {counts ? <p className="hint" data-testid="vault-counts">{counts.documents} 份文件・{counts.sources} 個訂閱</p> : null}
    <div className="settings-line vault-actions" data-testid="vault-actions">
      <div className="vault-action-group">
        <button type="button" className="button" disabled={!!unavailable || running} onClick={() => setOpen({ kind: 'open', resume: false })}
          data-testid="vault-open-other">開啟其他知識庫…</button>
        {desktop ? <button type="button" className="button" onClick={() => void reveal()} data-testid="vault-reveal">{revealLabel(desktop.platform)}</button> : null}
      </div>
      <div className="vault-action-group vault-actions-secondary">
        <button type="button" className="button" disabled={!!unavailable || running} onClick={() => setOpen({ kind: 'move', resume: false })}
          data-testid="vault-move">搬移…</button>
        {current ? <ExchangeActions onChanged={onChanged} /> : null}
      </div>
    </div>
    {unavailable ? <p className="hint" data-testid="vault-relocation-unavailable">{unavailable.message}</p> : null}
    {running && !open && status ? <div className="transfer-progress-line vault-background" data-testid="vault-background">
      <p className="transfer-progress" role="status"><span className="spinner" aria-hidden="true" />{status.message}</p>
      <button type="button" className="button small" onClick={() => {
        background = null;
        setOpen({ kind: status.operation === 'open' ? 'open' : 'move', resume: true });
      }}>查看</button>
    </div> : null}
    {problem ? <p className="add-problem" role="alert">{problem}</p> : null}
    {open?.kind === 'move' && current ? <MoveDialog vaultPath={current} resume={open.resume}
      onBackground={() => { background = 'move'; shownBefore.current = status; setOpen(null); }} onClose={close} /> : null}
    {open?.kind === 'open' && current ? <OpenOtherDialog vaultPath={current} activeJobs={activeJobs} resume={open.resume}
      onBackground={() => { background = 'open'; shownBefore.current = status; setOpen(null); }} onClose={close} /> : null}
  </section>;
}

/** Runs a move or switch that the server accepted, or follows one already running, to its end. */
function useRelocation(resume: boolean) {
  const [phase, setPhase] = useState<'input' | 'running' | 'done' | 'failed'>(resume ? 'running' : 'input');
  const [outcome, setOutcome] = useState<TransferStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'running');
  const followed = useRef(false);

  async function follow(): Promise<void> {
    const status = await followTransfer();
    setOutcome(status);
    if (status.state === 'completed') setPhase('done');
    else if (status.state === 'idle') { setFailure(status.message); setPhase('input'); }
    else { setFailure(status.message); setPhase('failed'); }
  }

  useEffect(() => {
    if (resume && !followed.current) {
      followed.current = true;
      follow().catch((error: unknown) => { setFailure(errorText(error, '無法讀取進度。')); setPhase('failed'); });
    }
  }, [resume]);

  async function start(request: () => Promise<TransferStatus>): Promise<void> {
    setFailure(null);
    setPhase('running');
    try {
      await request();
      await follow();
    } catch (error) {
      setFailure(errorText(error, '操作失敗，請稍後再試。'));
      setPhase('input');
    }
  }
  return { phase, outcome, failure, progress, start, setFailure };
}

function MoveDialog({ vaultPath, resume, onBackground, onClose }: {
  vaultPath: string; resume: boolean; onBackground: () => void; onClose: (switched: boolean) => void;
}) {
  const desktop = window.xrCollectorDesktop;
  const [target, setTarget] = useState('');
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const { phase, outcome, failure, progress, start, setFailure } = useRelocation(resume);

  // Checks the typed location after a pause in typing; a newer location aborts the older check.
  useEffect(() => {
    setCheck(null);
    setCheckProblem(null);
    const value = target.trim();
    if (!value || phase !== 'input') { setChecking(false); return undefined; }
    const controller = new AbortController();
    setChecking(true);
    const timer = window.setTimeout(() => {
      api.checkVaultMove(value, controller.signal)
        .then((result) => { setCheck(result); setChecking(false); })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setCheckProblem(errorText(error, '無法檢查這個位置。'));
          setChecking(false);
        });
    }, CHECK_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [target, phase]);

  async function chooseFolder(): Promise<void> {
    if (!desktop) return;
    try {
      const folder = await desktop.chooseDirectory(target || vaultPath);
      if (folder) setTarget(moveTargetIn(folder, vaultPath));
    } catch (error) {
      setFailure(`無法開啟資料夾選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  const result = outcome?.result;
  return <Modal title="搬移知識庫" wide busy={phase === 'running'} onDismiss={() => onClose(phase === 'done')} testId="move-dialog">
    {phase === 'input' ? <>
      <div className="path-row">
        <PathField label="新位置" value={target} onChange={setTarget} testId="move-target" hint="不存在或空的資料夾，完整路徑。" />
        {desktop ? <button type="button" className="button" onClick={() => void chooseFolder()} data-testid="move-choose-folder">選擇位置…</button> : null}
      </div>
      {checking ? <p className="hint" role="status">正在檢查位置…</p> : null}
      {checkProblem ? <p className="add-problem" role="alert" data-testid="move-check-problem">{checkProblem}</p> : null}
      {check ? <p className="hint" data-testid="move-space">需要 {sizeLabel(check.requiredBytes)}（含安全餘量）・可用 {sizeLabel(check.availableBytes)}</p> : null}
      <ul className="fact-list" data-testid="move-facts">
        <li>先等進行中的收集步驟完成；排隊的工作保留，搬移完成後在新位置接續。</li>
        <li>完整複製並逐檔檢查後才切換；切換前目前位置 <code>{vaultPath}</code> 的資料不會變動。</li>
        <li>切換成功後清除原位置。搬移期間可以瀏覽文件，加入內容與設定變更要等搬移完成。</li>
      </ul>
    </> : null}
    {phase === 'running' ? <>
      <Progress progress={progress} fallback="正在搬移…" />
      <p className="hint">搬移在背景進行時可以繼續瀏覽文件，完成後回到設定查看結果。</p>
    </> : null}
    {phase === 'done' && outcome ? <>
      <p className="transfer-done" role="status">已搬移並開始使用新位置。</p>
      <code className="setting-path" data-testid="move-result-path">{outcome.vaultPath}</code>
      {result?.leftoverPath
        ? <p className="move-leftover" role="alert" data-testid="move-leftover">原位置未能清除，請確認後手動刪除這個資料夾：<code>{result.leftoverPath}</code></p>
        : <p>原位置已清除。</p>}
      {result?.resumedJobs ? <p data-testid="move-resumed">{result.resumedJobs} 個收集工作在新位置接續。</p> : null}
    </> : null}
    {failure ? <p className="add-problem" role="alert" data-testid="move-failure">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!check || checking} onClick={() => void start(() => api.moveVault(check!.targetPath))}
          data-testid="move-confirm">搬移</button>
      </> : null}
      {phase === 'running' ? <button type="button" className="button" onClick={onBackground} data-testid="move-background">在背景繼續</button> : null}
      {phase === 'done' || phase === 'failed'
        ? <button type="button" className="button primary" onClick={() => onClose(phase === 'done')} data-testid="transfer-close">{phase === 'done' ? '完成' : '關閉'}</button>
        : null}
    </div>
  </Modal>;
}

function OpenOtherDialog({ vaultPath, activeJobs, resume, onBackground, onClose }: {
  vaultPath: string; activeJobs: number; resume: boolean; onBackground: () => void; onClose: (switched: boolean) => void;
}) {
  const desktop = window.xrCollectorDesktop;
  const [source, setSource] = useState('');
  const [found, setFound] = useState<{ path: string; documentCount: number } | null>(null);
  const [looking, setLooking] = useState(false);
  const { phase, outcome, failure, progress, start, setFailure } = useRelocation(resume);

  async function chooseFolder(): Promise<void> {
    if (!desktop) return;
    try {
      const folder = await desktop.chooseDirectory(source || vaultPath);
      if (folder) { setSource(folder); setFound(null); }
    } catch (error) {
      setFailure(`無法開啟資料夾選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  async function inspect(): Promise<void> {
    setFailure(null);
    setLooking(true);
    try {
      const inspection = await api.inspectVault(source.trim());
      if (inspection.kind === 'existing') setFound({ path: inspection.path, documentCount: inspection.documentCount });
      else setFailure(inspection.kind === 'empty' ? '這個資料夾還不是知識庫，請選擇已有的知識庫。' : inspection.reason);
    } catch (error) {
      setFailure(errorText(error, '無法檢查這個資料夾。'));
    } finally {
      setLooking(false);
    }
  }

  const result = outcome?.result;
  return <Modal title="開啟其他知識庫" wide busy={phase === 'running'} onDismiss={() => onClose(phase === 'done')} testId="open-vault-dialog">
    {phase === 'input' && !found ? <>
      <div className="path-row">
        <PathField label="知識庫資料夾" value={source} onChange={(value) => { setSource(value); setFound(null); }} testId="open-vault-path"
          hint="已有的知識庫資料夾，完整路徑。" />
        {desktop ? <button type="button" className="button" onClick={() => void chooseFolder()} data-testid="open-vault-choose">選擇資料夾…</button> : null}
      </div>
      <p className="hint">在這台電腦改用另一個知識庫。兩個知識庫各自保留內容與收集工作，不會合併。</p>
    </> : null}
    {phase === 'input' && found ? <>
      <ul className="fact-list" data-testid="open-vault-facts">
        <li>開啟 <code>{found.path}</code>，有 {found.documentCount} 份文件。</li>
        <li>目前的知識庫保留在 <code>{vaultPath}</code>，內容不會變更。</li>
        {activeJobs > 0
          ? <li data-testid="open-vault-paused">目前有 {activeJobs} 個收集工作：進行中的步驟先完成，其餘暫停，回到這個知識庫時接續。</li>
          : <li>目前沒有進行中的收集工作。</li>}
        <li>要開啟的知識庫有未完成的收集工作時，開啟後接續。</li>
      </ul>
    </> : null}
    {phase === 'running' ? <Progress progress={progress} fallback="正在開啟知識庫…" /> : null}
    {phase === 'done' && outcome ? <>
      <p className="transfer-done" role="status">已開啟知識庫。</p>
      <code className="setting-path" data-testid="open-vault-result-path">{outcome.vaultPath}</code>
      {result?.previousVaultPath ? <p>原知識庫保留在 <code>{result.previousVaultPath}</code>。{result.interruptedJobs ? `它的 ${result.interruptedJobs} 個收集工作已暫停，回到原知識庫時接續。` : ''}</p> : null}
      {result?.resumedJobs ? <p>這個知識庫有 {result.resumedJobs} 個收集工作接續。</p> : null}
    </> : null}
    {failure ? <p className="add-problem" role="alert" data-testid="open-vault-failure">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' && !found ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!source.trim() || looking} onClick={() => void inspect()} data-testid="open-vault-next">下一步</button>
      </> : null}
      {phase === 'input' && found ? <>
        <button type="button" className="button" onClick={() => { setFound(null); setFailure(null); }}>返回</button>
        <button type="button" className="button primary" onClick={() => void start(() => api.openOtherVault(found.path))} data-testid="open-vault-confirm">開啟</button>
      </> : null}
      {phase === 'running' ? <button type="button" className="button" onClick={onBackground}>在背景繼續</button> : null}
      {phase === 'done' || phase === 'failed'
        ? <button type="button" className="button primary" onClick={() => onClose(phase === 'done')} data-testid="transfer-close">{phase === 'done' ? '完成' : '關閉'}</button>
        : null}
    </div>
  </Modal>;
}

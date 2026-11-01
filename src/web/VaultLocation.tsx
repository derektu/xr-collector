import { useEffect, useRef, useState } from 'react';
import type { TransferStatus } from '../core/types.js';
import { api } from './api-client.js';
import { errorText, ExchangeActions, followTransfer, Modal, PathField, Progress, useTransferProgress } from './VaultExchange.js';
import { useLiveRead } from './use-changes.js';
import { relocates, revealLabel, transferRunning } from './transfer-presentation.js';
import { NewVaultFields, useNewVaultCheck } from './NewVaultFields.js';

/** The dialog shown: creating a new Vault or opening another, started here or followed after it ran in the background. */
type Open = { kind: 'create' | 'open'; resume: boolean; source?: string };

/**
 * The switch the person sent to the background. It outlives the Settings page, so returning to
 * Settings shows the outcome of the switch that ran while another page was open.
 */
let background: 'create' | 'open' | null = null;

const kindOf = (status: TransferStatus): 'create' | 'open' => (status.operation === 'create' ? 'create' : 'open');

/**
 * Settings section for the active Vault: where it is, what it holds, creating a new Vault or opening
 * another one in its place, and its export and import. Creating and opening are unavailable when the
 * status names a reason, such as a location fixed at startup.
 */
export function VaultLocationSection({ vaultPath, counts, onChanged }: {
  vaultPath: string | null;
  counts: { documents: number; sources: number } | null;
  onChanged: (message: string) => void;
}) {
  const desktop = window.xrCollectorDesktop;
  const [open, setOpen] = useState<Open | null>(null);
  // Follows the status while no dialog is open, so a switch running in the background shows its progress here.
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

  /** On the desktop the folder picker comes first, starting in the folder that holds the active Vault. */
  async function openOther(): Promise<void> {
    setProblem(null);
    if (!desktop) { setOpen({ kind: 'open', resume: false }); return; }
    try {
      const source = await desktop.chooseVault((await api.getVaultSetup()).newVault.location);
      if (source) setOpen({ kind: 'open', resume: false, source });
    } catch (error) {
      setProblem(`無法開啟資料夾選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  const close = (switched: boolean) => {
    setOpen(null);
    if (switched) window.location.reload();
  };
  const toBackground = () => { background = open?.kind ?? null; shownBefore.current = status; setOpen(null); };

  return <section className="settings-section" data-testid="settings-vault">
    <h2>知識庫</h2>
    <code className="setting-path" data-testid="vault-path">{current}</code>
    {counts ? <p className="hint" data-testid="vault-counts">{counts.documents} 份文件・{counts.sources} 個訂閱</p> : null}
    <div className="settings-line vault-actions" data-testid="vault-actions">
      <div className="vault-action-group">
        <button type="button" className="button" disabled={!!unavailable || running} onClick={() => setOpen({ kind: 'create', resume: false })}
          data-testid="vault-create">建立新的知識庫…</button>
        <button type="button" className="button" disabled={!!unavailable || running} onClick={() => void openOther()}
          data-testid="vault-open-other">開啟既有知識庫…</button>
        {desktop ? <button type="button" className="button" onClick={() => void reveal()} data-testid="vault-reveal">{revealLabel(desktop.platform)}</button> : null}
      </div>
      <div className="vault-action-group vault-actions-secondary">
        {current ? <ExchangeActions onChanged={onChanged} /> : null}
      </div>
    </div>
    {unavailable ? <p className="hint" data-testid="vault-relocation-unavailable">{unavailable.message}</p> : null}
    {running && !open && status ? <div className="transfer-progress-line vault-background" data-testid="vault-background">
      <p className="transfer-progress" role="status"><span className="spinner" aria-hidden="true" />{status.message}</p>
      <button type="button" className="button small" onClick={() => {
        background = null;
        setOpen({ kind: kindOf(status), resume: true });
      }}>查看</button>
    </div> : null}
    {problem ? <p className="add-problem" role="alert">{problem}</p> : null}
    {open?.kind === 'open' && current ? <OpenOtherDialog resume={open.resume}
      {...(open.source ? { source: open.source } : {})} onBackground={toBackground} onClose={close} /> : null}
    {open?.kind === 'create' && current ? <CreateDialog resume={open.resume}
      onBackground={toBackground} onClose={close} /> : null}
  </section>;
}

/** Runs a switch that the server accepted, or follows one already running, to its end. */
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

/** The outcome of a finished switch: the Vault now in use and where the previous one stays. */
function SwitchOutcome({ outcome, done, testId }: { outcome: TransferStatus; done: string; testId: string }) {
  const result = outcome.result;
  return <>
    <p className="transfer-done" role="status">{done}</p>
    <code className="setting-path" data-testid={testId}>{outcome.vaultPath}</code>
    {result?.previousVaultPath ? <p>原知識庫保留在 <code>{result.previousVaultPath}</code>。{result.interruptedJobs ? `它的 ${result.interruptedJobs} 個收集工作已暫停，回到原知識庫時接續。` : ''}</p> : null}
    {result?.resumedJobs ? <p>這個知識庫有 {result.resumedJobs} 個收集工作接續。</p> : null}
  </>;
}

/**
 * Creates a new Vault with the same name and location form as Onboarding, starting in the folder
 * that holds the active Vault, then switches to it. The active Vault stays where it is.
 */
function CreateDialog({ resume, onBackground, onClose }: {
  resume: boolean; onBackground: () => void; onClose: (switched: boolean) => void;
}) {
  const desktop = window.xrCollectorDesktop;
  const [name, setName] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const { check, checking, ready } = useNewVaultCheck(location ?? '', name ?? '');
  const { phase, outcome, failure, progress, start, setFailure } = useRelocation(resume);

  // A resumed create that ends cancelled returns to the form, so the defaults load either way.
  useEffect(() => {
    api.getVaultSetup().then((setup) => { setName(setup.newVault.name); setLocation(setup.newVault.location); })
      .catch((error: unknown) => setFailure(errorText(error, '無法讀取預設位置。')));
  }, []);

  async function chooseLocation(): Promise<void> {
    try {
      const chosen = await desktop?.chooseVaultLocation(location ?? undefined);
      if (chosen) setLocation(chosen);
    } catch (error) {
      setFailure(`無法開啟資料夾選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  return <Modal title="建立新的知識庫" {...(phase === 'input' ? { width: 'form' as const } : {})} busy={phase === 'running'} onDismiss={() => onClose(phase === 'done')} testId="create-vault-dialog">
    {phase === 'input' && name !== null && location !== null
      ? <NewVaultFields name={name} location={location} check={check} checking={checking} busy={false}
        onName={setName} onLocation={setLocation} {...(desktop ? { onChooseLocation: () => void chooseLocation() } : {})} />
      : null}
    {phase === 'running' ? <Progress progress={progress} fallback="正在建立知識庫…" /> : null}
    {phase === 'done' && outcome ? <SwitchOutcome outcome={outcome} done="已建立並開啟知識庫。" testId="create-vault-result-path" /> : null}
    {failure ? <p className="add-problem" role="alert" data-testid="create-vault-failure">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!ready || name === null || location === null}
          onClick={() => void start(() => api.createVault(location!, name!))} data-testid="create-vault-confirm">建立</button>
      </> : null}
      {phase === 'running' ? <button type="button" className="button" onClick={onBackground}>在背景繼續</button> : null}
      {phase === 'done' || phase === 'failed'
        ? <button type="button" className="button primary" onClick={() => onClose(phase === 'done')} data-testid="transfer-close">{phase === 'done' ? '完成' : '關閉'}</button>
        : null}
    </div>
  </Modal>;
}

/**
 * Opens another existing Vault in place of the active one as soon as the chosen folder proves to be
 * one. The desktop folder picker runs before the dialog and hands it `source`; a browser session types
 * the path here.
 */
function OpenOtherDialog({ resume, source: chosen, onBackground, onClose }: {
  resume: boolean; source?: string; onBackground: () => void; onClose: (switched: boolean) => void;
}) {
  const [source, setSource] = useState(chosen ?? '');
  const [looking, setLooking] = useState(false);
  const { phase, outcome, failure, progress, start, setFailure } = useRelocation(resume);

  async function open(path: string): Promise<void> {
    setFailure(null);
    setLooking(true);
    try {
      const inspection = await api.inspectVault(path);
      if (inspection.kind === 'existing') await start(() => api.openOtherVault(inspection.path));
      else setFailure(inspection.kind === 'empty' ? `「${baseName(inspection.path)}」不是 XR Collector 知識庫。` : inspection.reason);
    } catch (error) {
      setFailure(errorText(error, '無法檢查這個資料夾。'));
    } finally {
      setLooking(false);
    }
  }

  useEffect(() => {
    if (chosen && !resume) void open(chosen);
  }, [chosen, resume]);

  const typing = phase === 'input' && !chosen;
  return <Modal title="開啟既有知識庫" {...(typing ? { width: 'form' as const } : {})} busy={phase === 'running'} onDismiss={() => onClose(phase === 'done')} testId="open-vault-dialog">
    {typing ? <PathField label="知識庫資料夾" value={source} onChange={setSource} testId="open-vault-path" /> : null}
    {phase === 'input' && chosen && looking ? <p>正在檢查…</p> : null}
    {phase === 'running' ? <Progress progress={progress} fallback="正在開啟知識庫…" /> : null}
    {phase === 'done' && outcome ? <SwitchOutcome outcome={outcome} done="已開啟知識庫。" testId="open-vault-result-path" /> : null}
    {failure ? <p className="add-problem" role="alert" data-testid="open-vault-failure">{failure}</p> : null}
    <div className="dialog-actions">
      {typing ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!source.trim() || looking} onClick={() => void open(source.trim())} data-testid="open-vault-confirm">開啟</button>
      </> : null}
      {phase === 'input' && chosen ? <button type="button" className="button" onClick={() => onClose(false)}>關閉</button> : null}
      {phase === 'running' ? <button type="button" className="button" onClick={onBackground}>在背景繼續</button> : null}
      {phase === 'done' || phase === 'failed'
        ? <button type="button" className="button primary" onClick={() => onClose(phase === 'done')} data-testid="transfer-close">{phase === 'done' ? '完成' : '關閉'}</button>
        : null}
    </div>
  </Modal>;
}

/** The last segment of a path, on either platform's separator. */
function baseName(value: string): string {
  return value.split(/[\\/]/u).filter(Boolean).pop() ?? value;
}

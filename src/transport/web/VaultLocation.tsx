import { useEffect, useState } from 'react';
import type { TransferStatus } from '../../shared/vault/vault-types.js';
import { api } from './api-client.js';
import { errorText, ExchangeActions, followTransfer, Modal, PathField, Progress, useTransferProgress } from './VaultExchange.js';
import { useLiveRead } from './use-changes.js';
import { fileName, relocationPhase, revealLabel, switchesVault, transferRunning } from './transfer-presentation.js';
import { NewVaultFields, useNewVaultCheck } from './NewVaultFields.js';

type Open = { kind: 'create' } | { kind: 'open'; source?: string };

export function VaultLocationSection({ vaultPath, counts, onNotice }: {
  vaultPath: string | null;
  counts: { documents: number; sources: number } | null;
  onNotice: (message: string) => void;
}) {
  const desktop = window.xrCollectorDesktop;
  const [open, setOpen] = useState<Open | null>(null);
  const { value: status } = useLiveRead(['transfer'], (signal) => api.vaultTransferStatus(signal), [], { enabled: !open });
  const [problem, setProblem] = useState<string | null>(null);
  const current = status?.vaultPath ?? vaultPath;
  const unavailable = status?.relocationUnavailable ?? null;
  const running = switchesVault(status) && transferRunning(status);

  async function reveal(): Promise<void> {
    setProblem(null);
    try { await desktop?.revealVault(); } catch (error) { setProblem(errorText(error, '無法開啟資料夾。')); }
  }

  async function openOther(): Promise<void> {
    setProblem(null);
    if (!desktop) { setOpen({ kind: 'open' }); return; }
    try {
      const source = await desktop.chooseVault((await api.getVaultSetup()).newVault.location);
      if (source) setOpen({ kind: 'open', source });
    } catch (error) {
      setProblem(`無法開啟資料夾選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  const close = (switched: boolean) => {
    setOpen(null);
    if (switched) window.location.reload();
  };

  return <section className="settings-section" data-testid="settings-vault">
    <h2>知識庫</h2>
    <code className="setting-path" data-testid="vault-path">{current}</code>
    {counts ? <p className="hint" data-testid="vault-counts" data-documents={counts.documents} data-sources={counts.sources}>{counts.documents} 份文件・{counts.sources} 個訂閱</p> : null}
    <div className="settings-line vault-actions" data-testid="vault-actions">
      <div className="vault-action-group">
        <button type="button" className="button" disabled={!!unavailable || running} onClick={() => setOpen({ kind: 'create' })}
          data-testid="vault-create">建立新的知識庫…</button>
        <button type="button" className="button" disabled={!!unavailable || running} onClick={() => void openOther()}
          data-testid="vault-open-other">開啟既有知識庫…</button>
        {desktop ? <button type="button" className="button" onClick={() => void reveal()} data-testid="vault-reveal">{revealLabel(desktop.platform)}</button> : null}
      </div>
      <div className="vault-action-group vault-actions-secondary">
        {current ? <ExchangeActions onNotice={onNotice} /> : null}
      </div>
    </div>
    {unavailable ? <p className="hint" data-testid="vault-relocation-unavailable">{unavailable.message}</p> : null}
    {running && !open && status ? <p className="transfer-progress vault-switching" role="status" data-testid="vault-switching">
      <span className="spinner" aria-hidden="true" />{status.message}</p> : null}
    {problem ? <p className="add-problem" role="alert">{problem}</p> : null}
    {open?.kind === 'open' && current ? <OpenOtherDialog {...(open.source ? { source: open.source } : {})} onClose={close} /> : null}
    {open?.kind === 'create' && current ? <CreateDialog onClose={close} /> : null}
  </section>;
}

function useRelocation() {
  const [phase, setPhase] = useState<'input' | 'running' | 'done' | 'failed'>('input');
  const [outcome, setOutcome] = useState<TransferStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const progress = useTransferProgress(phase === 'running');

  async function start(request: () => Promise<TransferStatus>): Promise<void> {
    setFailure(null);
    setPhase('running');
    try {
      await request();
      const status = await followTransfer();
      const next = relocationPhase(status);
      setOutcome(status);
      if (next !== 'done') setFailure(status.message);
      setPhase(next);
    } catch (error) {
      setFailure(errorText(error, '操作失敗，請稍後再試。'));
      setPhase('input');
    }
  }
  return { phase, outcome, failure, progress, start, setFailure };
}

function SwitchOutcome({ outcome, done, testId }: { outcome: TransferStatus; done: string; testId: string }) {
  const result = outcome.result;
  return <>
    <p className="transfer-done" role="status">{done}</p>
    <code className="setting-path" data-testid={testId}>{outcome.vaultPath}</code>
    {result?.previousVaultPath ? <p>原知識庫保留在 <code>{result.previousVaultPath}</code>。{result.interruptedJobs ? `它的 ${result.interruptedJobs} 個收集工作已暫停，回到原知識庫時接續。` : ''}</p> : null}
    {result?.resumedJobs ? <p>這個知識庫有 {result.resumedJobs} 個收集工作接續。</p> : null}
  </>;
}

type NewVaultForm = { loaded: false } | { loaded: true; name: string; location: string };

function CreateDialog({ onClose }: { onClose: (switched: boolean) => void }) {
  const desktop = window.xrCollectorDesktop;
  const [form, setForm] = useState<NewVaultForm>({ loaded: false });
  const { check, checking } = useNewVaultCheck(form.loaded ? form.location : '', form.loaded ? form.name : '', form.loaded);
  const { phase, outcome, failure, progress, start, setFailure } = useRelocation();

  useEffect(() => {
    api.getVaultSetup().then((setup) => setForm({ loaded: true, name: setup.newVault.name, location: setup.newVault.location }))
      .catch((error: unknown) => setFailure(errorText(error, '無法讀取預設位置。')));
  }, []);

  const setName = (name: string) => { setFailure(null); setForm((current) => (current.loaded ? { ...current, name } : current)); };
  const setLocation = (location: string) => { setFailure(null); setForm((current) => (current.loaded ? { ...current, location } : current)); };

  async function chooseLocation(): Promise<void> {
    try {
      const chosen = await desktop?.chooseVaultLocation(form.loaded ? form.location : undefined);
      if (chosen) setLocation(chosen);
    } catch (error) {
      setFailure(`無法開啟資料夾選擇視窗：${errorText(error, '請稍後再試。')}`);
    }
  }

  return <Modal title="建立新的知識庫" {...(phase === 'input' ? { width: 'form' as const } : {})} busy={phase === 'running'} onDismiss={() => onClose(phase === 'done')} testId="create-vault-dialog">
    {phase === 'input' && form.loaded
      ? <NewVaultFields name={form.name} location={form.location} check={check} checking={checking} busy={false}
        onName={setName} onLocation={setLocation} {...(desktop ? { onChooseLocation: () => void chooseLocation() } : {})} />
      : null}
    {phase === 'running' ? <Progress progress={progress} fallback="正在建立知識庫…" /> : null}
    {phase === 'done' && outcome ? <SwitchOutcome outcome={outcome} done="已建立並開啟知識庫。" testId="create-vault-result-path" /> : null}
    {failure ? <p className="add-problem" role="alert" data-testid="create-vault-failure">{failure}</p> : null}
    <div className="dialog-actions">
      {phase === 'input' ? <>
        <button type="button" className="button" onClick={() => onClose(false)}>取消</button>
        <button type="button" className="button primary" disabled={!form.loaded}
          onClick={() => { if (form.loaded) void start(() => api.createVault(form.location, form.name)); }} data-testid="create-vault-confirm">建立</button>
      </> : null}
      {phase === 'done' || phase === 'failed'
        ? <button type="button" className="button primary" onClick={() => onClose(phase === 'done')} data-testid="transfer-close">{phase === 'done' ? '完成' : '關閉'}</button>
        : null}
    </div>
  </Modal>;
}

function OpenOtherDialog({ source: chosen, onClose }: { source?: string; onClose: (switched: boolean) => void }) {
  const [source, setSource] = useState(chosen ?? '');
  const [looking, setLooking] = useState(false);
  const { phase, outcome, failure, progress, start, setFailure } = useRelocation();

  async function open(path: string): Promise<void> {
    setFailure(null);
    setLooking(true);
    try {
      const inspection = await api.inspectVault(path);
      if (inspection.kind === 'existing') await start(() => api.openOtherVault(inspection.path));
      else setFailure(inspection.kind === 'empty' ? `「${fileName(inspection.path)}」不是 XR Collector 知識庫。` : inspection.reason);
    } catch (error) {
      setFailure(errorText(error, '無法檢查這個資料夾。'));
    } finally {
      setLooking(false);
    }
  }

  useEffect(() => {
    if (chosen) void open(chosen);
  }, [chosen]);

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
      {phase === 'done' || phase === 'failed'
        ? <button type="button" className="button primary" onClick={() => onClose(phase === 'done')} data-testid="transfer-close">{phase === 'done' ? '完成' : '關閉'}</button>
        : null}
    </div>
  </Modal>;
}

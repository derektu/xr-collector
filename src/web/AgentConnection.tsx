import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type AgentConnectionStatus, type AgentPortSetting } from './api-client.js';
import { AgentConnectionHelp } from './AgentConnectionHelp.js';

function message(error: unknown): string { return error instanceof Error ? error.message : '發生未預期的錯誤。'; }

export function AgentConnection() {
  const [status, setStatus] = useState<AgentConnectionStatus | null>(null);
  const [summaryMessage, setSummaryMessage] = useState<string>();
  const [dialogMessage, setDialogMessage] = useState<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'auto' | 'fixed'>('auto');
  const [port, setPort] = useState('7222');
  useEffect(() => { void api.getAgentConnectionStatus().then((next) => { setStatus(next); resetDraft(next); }).catch((failure) => setSummaryMessage(message(failure))); }, []);
  const available = status?.state === 'available';
  useLayoutEffect(() => {
    if (dialogOpen && !dialog.current?.open) dialog.current?.showModal();
    if (!dialogOpen && dialog.current?.open) dialog.current.close();
  });
  function resetDraft(current = status): void {
    if (!current) return;
    setMode(current.configured.mode);
    setPort(String(current.configured.mode === 'fixed' ? current.configured.port : current.activePort ?? 7222));
    setConfirmReset(false);
    setDialogMessage(undefined);
  }
  function openDialog(): void { resetDraft(); setDialogOpen(true); }
  function closeDialog(): void { resetDraft(); setDialogOpen(false); }
  async function copy(): Promise<void> {
    try { const connection = await api.agentConnection(); await navigator.clipboard.writeText(JSON.stringify(connection, null, 2)); setSummaryMessage('已複製連線資料。'); }
    catch (failure) { setSummaryMessage(message(failure)); }
  }
  async function download(): Promise<void> {
    try { const blob = await api.downloadAgentSkill(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'xr-collector-agent.zip'; anchor.click(); URL.revokeObjectURL(url); setSummaryMessage('Skill 下載已開始。'); }
    catch (failure) { setSummaryMessage(message(failure)); }
  }
  async function save(): Promise<void> {
    const next: AgentPortSetting = mode === 'auto' ? { mode: 'auto' } : { mode: 'fixed', port: Number(port) };
    setBusy(true); setDialogMessage(undefined);
    try { const saved = await api.setAgentPort(next); setStatus(saved); resetDraft(saved); setDialogOpen(false); }
    catch (failure) { setDialogMessage({ text: message(failure), error: true }); }
    finally { setBusy(false); }
  }
  async function reset(): Promise<void> {
    setBusy(true); setDialogMessage(undefined);
    try { await api.resetAgentKey(); setConfirmReset(false); setDialogMessage({ text: '連線金鑰已重設，請重新下載或複製連線資料。', error: false }); }
    catch (failure) { setDialogMessage({ text: message(failure), error: true }); }
    finally { setBusy(false); }
  }
  const stateLabel = !status ? '讀取中' : available ? '可連線' : '無法連線';
  return <section className="settings-section agent-connection" data-testid="settings-agent-connection">
    <div className="agent-summary"><div className="agent-info">
      <div className="agent-heading"><h2>AI 助理連線</h2><AgentConnectionHelp /><span className={`agent-state ${available ? 'ready' : status ? 'error' : ''}`}>{stateLabel}</span></div>
      {status?.activeUrl ? <code className="setting-path" data-testid="agent-active-url">{status.activeUrl}</code> : null}
    </div>
    <div className="settings-line agent-actions">
      <button className="button primary" type="button" disabled={!available} onClick={() => void download()}>下載 Skill</button>
      <button className="button" type="button" disabled={!available} onClick={() => void copy()}>複製連線資料</button>
      <button className="button" type="button" onClick={openDialog}>連線設定…</button>
    </div></div>
    {!status || !available ? <p className={!status ? 'setting-message' : 'setting-message error'}>{status?.message ?? '正在讀取連線狀態…'}</p> : null}
    {status?.restartRequired ? <p className="agent-restart" data-testid="agent-restart-required">設定已保存，重新啟動 XR Collector 後套用；目前連線保持不變。重啟後請重新下載 Skill 或複製連線資料。</p> : null}
    {summaryMessage ? <p className={summaryMessage.startsWith('已') || summaryMessage.includes('開始') ? 'setting-message' : 'setting-message error'} role="status">{summaryMessage}</p> : null}
    <dialog className="confirm-dialog agent-dialog" ref={dialog} aria-labelledby="agent-dialog-title" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
      <h2 id="agent-dialog-title">AI 助理連線設定</h2>
      <fieldset className="choice-list"><legend className="visually-hidden">連線埠</legend>
        <label className="choice"><input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} />自動選擇可用連線埠</label>
        <label className="choice"><input type="radio" checked={mode === 'fixed'} onChange={() => setMode('fixed')} />固定連線埠
          <input className="agent-port-input" type="number" min="1" max="65535" value={port} disabled={mode !== 'fixed'} onChange={(event) => setPort(event.target.value)} /></label>
      </fieldset>
      <p className="hint">連線埠變更會在下次啟動套用，不會中斷目前的工作。</p>
      {dialogMessage ? <p className={dialogMessage.error ? 'setting-message error' : 'setting-message'} role={dialogMessage.error ? 'alert' : 'status'} data-testid="agent-dialog-message">{dialogMessage.text}</p> : null}
      {confirmReset ? <div className="agent-reset-confirm" role="alertdialog" aria-labelledby="agent-reset-title">
        <h3 id="agent-reset-title">確定要重設連線金鑰？</h3>
        <p>目前使用這把金鑰的 Agent 會立即無法連線；已接受的工作不會停止。</p>
        <div className="dialog-actions"><button className="button" type="button" disabled={busy} onClick={() => setConfirmReset(false)}>取消</button>
          <button className="button danger-button" type="button" disabled={busy} onClick={() => void reset()}>確認重設</button></div>
      </div> : <button className="button danger-button" type="button" disabled={busy || !available} onClick={() => setConfirmReset(true)}>重設連線金鑰</button>}
      <div className="dialog-actions"><button className="button" type="button" onClick={closeDialog}>取消</button><button className="button primary" type="button" disabled={busy} onClick={() => void save()}>保存設定</button></div>
    </dialog>
  </section>;
}

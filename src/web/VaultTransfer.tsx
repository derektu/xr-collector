import { VaultMerge } from './VaultMerge.js';
import { useEffect, useState } from 'react';
import type { TransferStatus } from '../core/types.js';

const active = (status: TransferStatus | null) => !!status && !['idle', 'completed', 'error'].includes(status.state);
async function check(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  }
  return response;
}

export function VaultTransfer() {
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const next = await (await check(await fetch('/api/vault/status'))).json() as TransferStatus;
        if (!stopped) setStatus(next);
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : '無法取得搬移狀態。');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  async function exportData() {
    setBusy(true); setError(''); setMessage('正在下載資料包…');
    try {
      const response = await check(await fetch('/api/vault/export', { method: 'POST' }));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = `xr-collector-${new Date().toISOString().slice(0, 10)}.xr-vault`;
      document.body.append(link); link.click(); link.remove();
      // The native save dialog may remain open indefinitely; release only when the page leaves.
      window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
      setMessage('資料包已送交下載，請確認檔案已保存。');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '匯出失敗。'); setMessage(''); }
    finally { setBusy(false); }
  }

  async function restoreData() {
    if (!file) return;
    setBusy(true); setError(''); setMessage('正在上傳資料包…');
    try {
      if (file.size > 128 * 1024 * 1024) throw new Error('資料包超過 128 MiB。');
      const response = await check(await fetch('/api/vault/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      }));
      let next = await response.json() as TransferStatus;
      setStatus(next); setMessage('');
      while (active(next)) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        next = await (await check(await fetch('/api/vault/status'))).json() as TransferStatus;
        setStatus(next);
      }
      if (next.state === 'completed') window.location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '還原失敗。'); setMessage(''); }
    finally { setBusy(false); }
  }

  return <details className="agent-panel">
    <summary>資料匯出、還原與合併</summary>
    <p>匯出文件、保留附件及頻道設定。還原會建立並切換到獨立 vault，原 vault 保留，排程先暫停。</p>
    <p className="vault-path">目前 vault：{status?.vaultPath ?? '讀取中…'}</p>
    <div className="vault-actions">
      <button type="button" disabled={busy || active(status)} onClick={() => void exportData()}>匯出完整資料包</button>
      <label>選擇資料包 <input aria-label="選擇資料包" type="file" accept=".xr-vault" disabled={busy || active(status)} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <button type="button" disabled={!file || busy || active(status)} onClick={() => void restoreData()}>還原成新 vault 並切換</button>
    </div>
    <VaultMerge file={file} disabled={busy || active(status)} onBusy={setBusy} onStatus={(next) => { setStatus(next); setMessage(''); }} />
    <p>上限：128 MiB 資料包、80 MiB 檔案內容、10000 個檔案。搜尋索引與裝置憑證不包含在資料包中。</p>
    {(message || status?.message) && <p role="status">{message || status?.message}
      {status?.state === 'extracting' ? `（${status.completedFiles} / ${status.totalFiles}）` : ''}
    </p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}

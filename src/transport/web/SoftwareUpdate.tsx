import { useState } from 'react';
import type { DeviceUpdateStatus } from '../../shared/api/update-types.js';
import { api } from './api-client.js';

export function SoftwareUpdate({ status, onStatus }: { status: DeviceUpdateStatus | null; onStatus: (status: DeviceUpdateStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deferredVersion, setDeferredVersion] = useState<string>();
  const ready = status?.ready;
  const download = status?.offer;
  const newerOffer = ready && download && ready.version !== download.version ? download : null;
  const action = async (work: () => Promise<DeviceUpdateStatus>) => {
    setBusy(true); setError(undefined);
    try { onStatus(await work()); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '無法完成更新操作。'); }
    finally { setBusy(false); }
  };
  const phase = status?.phase;
  const canDownload = Boolean(download && status?.installerAvailable && (phase === 'available' || phase === 'ready' && newerOffer
    || phase === 'error' && (!ready || newerOffer)));
  const canApply = Boolean(ready && status?.installerAvailable && (phase === 'ready' || phase === 'error'));
  const attemptProblem = status?.lastAttempt?.outcome === 'incomplete' ? status.lastAttempt : null;
  return <div className="software-update" id="software-update" data-testid="software-update">
    <div className="software-update-line">
      <span className={status?.phase === 'available' || ready ? 'update-state available' : 'update-state'}>{status?.message ?? '正在讀取更新狀態…'}</span>
      <div className="software-update-actions">
        {canDownload && download ? <button type="button" className="button primary" data-testid="update-download"
          disabled={busy} onClick={() => void action(() => api.downloadUpdate(download.version))}>
          {newerOffer ? `下載 ${newerOffer.version}` : '下載更新'}</button> : null}
        {phase === 'downloading' ? <button type="button" className="button" data-testid="update-cancel"
          onClick={() => void action(() => api.cancelUpdate())}>取消下載</button> : null}
        {canApply && ready ? <>
          <button type="button" className="button primary" data-testid="update-apply" disabled={busy}
            onClick={() => void action(() => api.applyUpdate(ready.version))}>重新啟動以安裝</button>
          <button type="button" className="button" data-testid="update-later" onClick={() => setDeferredVersion(ready.version)}>稍後</button>
        </> : null}
        {phase === 'ready' && ready && deferredVersion === ready.version ? <span className="update-deferred" data-testid="update-deferred">已保留，可隨時安裝</span> : null}
        {status && ['idle', 'up_to_date', 'error', 'ready'].includes(status.phase) ? <button type="button" className="button" data-testid="update-check"
          disabled={busy} onClick={() => void action(() => api.checkForUpdate())}>{status.phase === 'error' ? '重新檢查' : '檢查更新'}</button> : null}
      </div>
    </div>
    {status?.progress && status.progress.total > 0 ? <progress max={status.progress.total} value={status.progress.transferred} aria-label="更新下載進度" /> : null}
    {attemptProblem ? <p className="setting-message error" role="alert" data-testid="update-attempt-problem">{attemptProblem.message}</p> : null}
    {error ? <p className="setting-message error" role="alert">{error}</p> : null}
  </div>;
}

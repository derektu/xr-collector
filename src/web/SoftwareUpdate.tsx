import { useRef, useState, type RefObject } from 'react';
import type { DeviceUpdateStatus, UpdateOffer } from '../core/types.js';
import { api } from './api-client.js';
import { MarkdownBody } from './MarkdownBody.js';

export function SoftwareUpdate({ status, onStatus }: { status: DeviceUpdateStatus | null; onStatus: (status: DeviceUpdateStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deferredVersion, setDeferredVersion] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const ready = status?.ready;
  const download = status?.offer;
  const newerOffer = ready && download && (ready.version !== download.version || ready.payload.sha256 !== download.payload.sha256)
    ? download : null;
  const offer = newerOffer ?? ready ?? download;
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
  const attemptProblem = status?.lastAttempt && ['failed', 'unknown'].includes(status.lastAttempt.outcome) ? status.lastAttempt : null;
  const cancel = (label: string) => <button type="button" className="button" data-testid="update-cancel"
    onClick={() => void action(() => api.cancelUpdate())}>{label}</button>;
  return <div className="software-update" id="software-update" data-testid="software-update">
    <div className="software-update-line">
      <span className={status?.phase === 'available' || ready ? 'update-state available' : 'update-state'}>{status?.message ?? '正在讀取更新狀態…'}</span>
      <div className="software-update-actions">
        {offer?.releaseNotes ? <button type="button" className="release-notes-link" onClick={() => dialog.current?.showModal()}>版本說明</button> : null}
        {canDownload && download ? <button type="button" className="button primary" data-testid="update-download"
          disabled={busy} onClick={() => void action(() => api.downloadUpdate(download.version, download.payload.sha256))}>
          {newerOffer ? `下載 ${newerOffer.version}` : '下載更新'}</button> : null}
        {phase === 'downloading' || (phase === 'verifying' && Boolean(status?.progress)) ? cancel('取消下載') : null}
        {canApply && ready ? <>
          <button type="button" className="button primary" data-testid="update-apply" disabled={busy}
            onClick={() => void action(() => api.applyUpdate(ready.version, ready.payload.sha256))}>重新啟動以安裝</button>
          <button type="button" className="button" data-testid="update-later" onClick={() => setDeferredVersion(ready.version)}>稍後</button>
        </> : null}
        {phase === 'waiting' || (phase === 'verifying' && Boolean(ready) && !status?.progress) ? cancel('取消等待') : null}
        {phase === 'ready' && ready && deferredVersion === ready.version ? <span className="update-deferred">已保留，可隨時安裝</span> : null}
        {status && ['idle', 'up_to_date', 'error', 'ready'].includes(status.phase) ? <button type="button" className="button" data-testid="update-check"
          disabled={busy} onClick={() => void action(() => api.checkForUpdate())}>{status.phase === 'error' ? '重新檢查' : '檢查更新'}</button> : null}
      </div>
    </div>
    {status?.progress ? <progress max={status.progress.total} value={status.progress.transferred} aria-label="更新下載進度" /> : null}
    {attemptProblem ? <p className="setting-message error" role="alert" data-testid="update-attempt-problem">{attemptProblem.message}</p> : null}
    {error ? <p className="setting-message error" role="alert">{error}</p> : null}
    <ReleaseNotes dialog={dialog} offer={offer} />
  </div>;
}

function ReleaseNotes({ dialog, offer }: { dialog: RefObject<HTMLDialogElement | null>; offer: UpdateOffer | null | undefined }) {
  return <dialog ref={dialog} className="confirm-dialog release-notes-dialog" aria-labelledby="release-notes-title">
    <h2 id="release-notes-title">{offer ? `${offer.version} 版本說明` : '版本說明'}</h2>
    <div className="release-notes-body">{offer ? <MarkdownBody markdown={offer.releaseNotes} /> : null}</div>
    <div className="dialog-actions"><button type="button" className="button" onClick={() => dialog.current?.close()}>關閉</button></div>
  </dialog>;
}

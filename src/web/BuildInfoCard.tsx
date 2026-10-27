import { useEffect, useState } from 'react';
import type { BuildInfo, DeviceUpdateStatus } from '../core/types.js';
import { api } from './api-client.js';
import './build-info.css';
import { SoftwareUpdate } from './SoftwareUpdate.js';

/** Build identity comes from the same device API used by an authorized Agent. */
export function BuildInfoCard({ compact = false, update = null, onUpdate }: { compact?: boolean; update?: DeviceUpdateStatus | null; onUpdate?: (status: DeviceUpdateStatus) => void }) {
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void api.buildInfo(controller.signal).then(setInfo).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [revision]);
  return <section className={compact ? 'build-info-compact' : 'settings-section build-info'} aria-label="建置資訊" data-testid="build-info">
    {!compact ? <h2>關於 XR Collector</h2> : null}
    {failed ? <p role="alert">無法讀取建置資訊。<button type="button" className="link-button" onClick={() => setRevision((value) => value + 1)}>重試</button></p>
      : !info ? <p role="status">正在讀取建置資訊…</p>
        : <>
          <p className="build-info-version"><span data-testid="build-info-version">{info.version}</span> · <span data-testid="build-info-kind">{info.kind === 'packaged' ? '安裝版' : '開發版'}</span>
            {info.sourceDirty === true ? '（有未提交修改）' : info.sourceDirty === null ? '（原始碼狀態未知）' : null}</p>
          {!compact && onUpdate ? <SoftwareUpdate status={update} onStatus={onUpdate} /> : null}
          <dl>
            <div><dt>建置時間</dt><dd><time data-testid="build-info-time" dateTime={info.builtAt}>{info.builtAt}</time></dd></div>
            <div><dt>Commit</dt><dd data-testid="build-info-commit">{info.commit ?? '未知'}</dd></div>
            <div><dt>建置編號</dt><dd data-testid="build-info-id">{info.buildId}</dd></div>
            <div><dt>平台</dt><dd data-testid="build-info-target">{info.target}</dd></div>
            <div><dt>搜尋引擎</dt><dd data-testid="build-info-variant">{info.variant === 'chinese' ? '中文精簡' : info.variant === 'official' ? '官方完整版' : '尚未準備'}</dd></div>
          </dl>
        </>}
  </section>;
}

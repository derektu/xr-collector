import { useState } from 'react';
import type { DeviceUpdateStatus } from '../../../shared/api/update-types.js';
import { api } from '../api/api-client.js';
import './build-info.css';
import { useRead } from '../infra/use-read.js';
import { SoftwareUpdate } from './SoftwareUpdate.js';

export function BuildInfoCard({ compact = false, update = null, onUpdate }: { compact?: boolean; update?: DeviceUpdateStatus | null; onUpdate?: (status: DeviceUpdateStatus) => void }) {
  const [revision, setRevision] = useState(0);
  const read = useRead((signal) => api.buildInfo(signal), [revision]);
  const info = read.value;
  const failed = read.error !== null && !read.pending;
  return <section className={compact ? 'build-info-compact' : 'settings-section build-info'} aria-label="建置資訊" data-testid="build-info">
    {!compact ? <h2>關於 XR Collector</h2> : null}
    {failed ? <p role="alert">無法讀取建置資訊。<button type="button" className="link-button" onClick={() => setRevision((value) => value + 1)}>重試</button></p>
      : !info ? <p role="status">正在讀取建置資訊…</p>
        : <>
          <p className="build-info-version"><span data-testid="build-info-version">{info.version}</span> · <span data-testid="build-info-kind" data-kind={info.kind}>{info.kind === 'packaged' ? '安裝版' : '開發版'}</span>
          </p>
          {!compact && onUpdate ? <SoftwareUpdate status={update} onStatus={onUpdate} /> : null}
        </>}
  </section>;
}

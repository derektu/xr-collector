import type { DeviceUpdateStatus } from '../core/types.js';

/** Short action label beside the version; quiet phases deliberately show only the version. */
export function sidebarUpdateLabel(status: DeviceUpdateStatus): string | null {
  if (!status.installerAvailable) return null;
  switch (status.phase) {
    case 'available': return status.offer ? '有新版本' : null;
    case 'downloading': return '下載中';
    case 'verifying': return '驗證中';
    case 'ready': return status.ready ? '可安裝' : null;
    case 'waiting': return status.ready ? '等待安裝' : null;
    case 'installing': return status.ready ? '安裝中' : null;
    default: return null;
  }
}

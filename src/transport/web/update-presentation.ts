import type { DeviceUpdateStatus } from '../../shared/api/update-types.js';

export type SidebarUpdate = 'available' | 'downloading' | 'ready' | 'installing';

export function sidebarUpdate(status: DeviceUpdateStatus): SidebarUpdate | null {
  if (!status.installerAvailable) return null;
  switch (status.phase) {
    case 'available': return status.offer ? 'available' : null;
    case 'downloading': return status.phase;
    case 'ready': case 'installing': return status.ready ? status.phase : null;
    default: return null;
  }
}

const LABELS: Record<SidebarUpdate, string> = {
  available: '有新版本', downloading: '下載中', ready: '可安裝', installing: '安裝中',
};

export function sidebarUpdateLabel(status: DeviceUpdateStatus): string | null {
  const step = sidebarUpdate(status);
  return step ? LABELS[step] : null;
}

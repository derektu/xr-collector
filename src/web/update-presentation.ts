import type { DeviceUpdateStatus } from '../core/types.js';

/** The update step the sidebar names beside the version. */
export type SidebarUpdate = 'available' | 'downloading' | 'verifying' | 'ready' | 'waiting' | 'installing';

/**
 * The step to name, or null when there is none to act on: quiet phases show only the version, a
 * new version shows only with a discovered offer, and the install steps only with a ready download.
 */
export function sidebarUpdate(status: DeviceUpdateStatus): SidebarUpdate | null {
  if (!status.installerAvailable) return null;
  switch (status.phase) {
    case 'available': return status.offer ? 'available' : null;
    case 'downloading': case 'verifying': return status.phase;
    case 'ready': case 'waiting': case 'installing': return status.ready ? status.phase : null;
    default: return null;
  }
}

const LABELS: Record<SidebarUpdate, string> = {
  available: '有新版本', downloading: '下載中', verifying: '驗證中', ready: '可安裝', waiting: '等待安裝', installing: '安裝中',
};

/** Short action label beside the version. */
export function sidebarUpdateLabel(status: DeviceUpdateStatus): string | null {
  const step = sidebarUpdate(status);
  return step ? LABELS[step] : null;
}

import type { DeviceUpdateStatus } from '../../shared/api/update-types.js';
import { downloadPercent, updateStepText, type UpdateStep } from '../../shared/api/update-step.js';

export function sidebarUpdate(status: DeviceUpdateStatus): UpdateStep | null {
  if (!status.installerAvailable) return null;
  switch (status.phase) {
    case 'available': return status.offer ? 'available' : null;
    case 'downloading': return status.phase;
    case 'ready': case 'installing': return status.ready ? status.phase : null;
    default: return null;
  }
}

export function sidebarUpdateLabel(status: DeviceUpdateStatus): string | null {
  const step = sidebarUpdate(status);
  return step ? updateStepText(step, downloadPercent(status.progress)) : null;
}

export type UpdateMessageTone = 'problem' | 'offer' | 'plain';

export function updateMessageTone(status: DeviceUpdateStatus): UpdateMessageTone {
  if (status.errorCode) return 'problem';
  return status.phase === 'available' || status.ready ? 'offer' : 'plain';
}

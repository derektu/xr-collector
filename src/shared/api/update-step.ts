import type { DeviceUpdateStatus } from './update-types.js';

export type UpdateStep = 'available' | 'downloading' | 'ready' | 'installing';

const STEP_TEXT: Record<UpdateStep, string> = {
  available: '有新版本', downloading: '下載中', ready: '可安裝', installing: '安裝中',
};

export function updateStepText(step: UpdateStep, percent: number | null = null): string {
  return step === 'downloading' && percent !== null ? `${STEP_TEXT.downloading} ${percent}%` : STEP_TEXT[step];
}

export function downloadPercent(progress: DeviceUpdateStatus['progress']): number | null {
  return progress && progress.total > 0 ? progress.percent : null;
}

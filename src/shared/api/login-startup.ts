import { CollectorError } from '../lib/collector-error.js';
import type { LoginStartupState, LoginStartupStatus } from './device-types.js';

export interface LoginStartupAccess {
  status(): Promise<LoginStartupStatus>;
  update(enabled: boolean): Promise<LoginStartupStatus>;
}

const MESSAGES: Record<LoginStartupState, string> = {
  enabled: '已在登入電腦時自動啟動。',
  disabled: '登入自啟已關閉。',
  requires_approval: '請到「系統設定 → 一般 → 登入項目與延伸功能」允許 XR Collector。',
  relocated: 'XR Collector 的 App 位置已變更；如要使用登入自啟，請在此重新開啟。',
  unavailable: '登入自啟只可在已安裝的 macOS 或 Windows App 中設定。',
};

export function loginStartupStatus(state: LoginStartupState): LoginStartupStatus {
  return { supported: state !== 'unavailable', enabled: state === 'enabled', state, message: MESSAGES[state] };
}

export const unavailableLoginStartup: LoginStartupAccess = {
  status: async () => loginStartupStatus('unavailable'),
  update: async () => { throw new CollectorError('login_startup_unavailable', MESSAGES.unavailable); },
};

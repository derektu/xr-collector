import { CollectorError, type LoginStartupStatus } from './types.js';

/** The one device setting exposed to both UI and Agent HTTP listeners. */
export interface LoginStartupAccess {
  status(): Promise<LoginStartupStatus>;
  update(enabled: boolean): Promise<LoginStartupStatus>;
}

const MESSAGE = '登入自啟只可在已安裝的 macOS 或 Windows App 中設定。';

/** Used by the browser development server and any unsupported platform. */
export const unavailableLoginStartup: LoginStartupAccess = {
  status: async () => ({ supported: false, enabled: false, state: 'unavailable', message: MESSAGE }),
  update: async () => { throw new CollectorError('login_startup_unavailable', MESSAGE); },
};

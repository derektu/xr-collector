import { CollectorError } from '../core/types.js';
import type { NativeInstaller } from './types.js';

export class UnavailableInstaller implements NativeInstaller {
  readonly available = false;
  async validate(): Promise<void> {}
  async prepare(): Promise<never> { throw new CollectorError('update_install_unavailable', '此執行環境無法安裝更新。'); }
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NsisUpdater } from 'electron-updater';
import type { AppAdapter } from 'electron-updater/out/AppAdapter.js';
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper.js';
import { CollectorError, type UpdateOffer } from '../core/types.js';
import type { NativeInstaller, PreparedInstall } from './types.js';

/** Exposes electron-updater's standard verified-cache to silent NSIS install seam. */
export class PinnedNsisUpdater extends NsisUpdater {
  private installError: Error | null = null;
  constructor(app?: AppAdapter) {
    super(null, app);
    // electron-updater reports both synchronous validation failures and later spawn failures on
    // EventEmitter's special "error" channel. Always consume it so a late error is not unhandled.
    this.on('error', (error: Error) => { this.installError = error; });
  }
  async accept(offer: UpdateOffer, file: string): Promise<void> {
    // Invoke NsisUpdater's normal publisher policy: unsigned builds have no publisherName, while
    // future signed builds are checked against their packaged app-update.yml identity.
    const verify = Reflect.get(this, 'verifySignature') as (file: string) => Promise<string | null>;
    const signatureError = await verify.call(this, file);
    if (signatureError) throw new CollectorError('update_integrity_failed', `Windows 安裝檔簽章驗證失敗：${signatureError}`);
    const sha512 = await digest512(file);
    const updateInfo = {
      version: offer.version, files: [{ url: offer.payload.name, sha512, size: offer.payload.bytes }],
      path: offer.payload.name, sha512, releaseDate: offer.buildInfo.builtAt,
    };
    const fileInfo = { url: pathToFileURL(file), info: { url: offer.payload.name, sha512, size: offer.payload.bytes } };
    // The helper is normally created by electron-updater's download pipeline after reading
    // app-update.yml. We deliberately do not configure its provider: discovery/download belong to
    // UpdateSource/UpdateService. Register the already verified bytes in the same native cache seam.
    this.downloadedUpdateHelper ??= new DownloadedUpdateHelper(path.dirname(file));
    await this.downloadedUpdateHelper.setDownloadedFile(file, null, updateInfo, fileInfo, path.basename(file), false);
  }
  async installPinned(): Promise<void> {
    this.installError = null;
    const accepted = this.install(true, true);
    // Allow an immediate child-process error to reach the updater before the old App exits. Once
    // NSIS has started, its eventual install result has no callback and is reconciled next launch.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const problem = this.installError as Error | null;
    if (problem) throw new CollectorError('update_apply_failed', `Windows 安裝程式無法啟動：${problem.message}`, { cause: problem });
    if (!accepted) throw new CollectorError('update_apply_failed', 'Windows 安裝程式無法啟動。');
  }
}

export interface WindowsUpdaterAdapter {
  accept(offer: UpdateOffer, file: string): Promise<void>;
  installPinned(): Promise<void>;
}

/** Uses electron-updater 6.8.3's NSIS path without automatic check, download, quit or install. */
export class WindowsNativeInstaller implements NativeInstaller {
  readonly available: boolean;
  private readonly updater: WindowsUpdaterAdapter;
  constructor(packaged: boolean, dependencies: { platform?: NodeJS.Platform; updater?: WindowsUpdaterAdapter } = {}) {
    this.available = (dependencies.platform ?? process.platform) === 'win32' && packaged;
    const updater = dependencies.updater ?? new PinnedNsisUpdater();
    if (updater instanceof PinnedNsisUpdater) {
      updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    }
    this.updater = updater;
  }
  async validate(offer: UpdateOffer, packageFile: string): Promise<void> {
    if (!this.available || offer.target !== 'win32-x64' || !packageFile.toLowerCase().endsWith('.exe')) {
      throw new CollectorError('update_install_unavailable', '這份更新不能由目前的 Windows App 安裝。');
    }
  }
  async prepare(offer: UpdateOffer, packageFile: string, signal: AbortSignal): Promise<PreparedInstall> {
    await this.validate(offer, packageFile); if (signal.aborted) throw signal.reason;
    await this.updater.accept(offer, packageFile); if (signal.aborted) throw signal.reason;
    let finished = false;
    return {
      handoff: async () => { if (finished) return; await this.updater.installPinned(); finished = true; },
      cancel: async () => { finished = true; },
    };
  }
}

async function digest512(file: string): Promise<string> {
  const hash = createHash('sha512'); for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer); return hash.digest('base64');
}

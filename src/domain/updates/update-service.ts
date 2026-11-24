import path from 'node:path';
import type { EventType } from '../../shared/activity/event-catalog.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { DeviceUpdateStatus, UpdateInstallResult, UpdateOffer, UpdateSelection } from '../../shared/api/update-types.js';
import { readJsonFile, writeJsonFile } from '../../shared/lib/json-file.js';
import type { AppUpdater, UpdateAccess } from './types.js';

interface SavedUpdateState {
  lastCheckAttemptAt: string | null;
  checkedAt: string | null;
  installing: { version: string; failure: string | null } | null;
}

export interface UpdateServiceOptions {
  updater: AppUpdater;
  currentVersion: string;
  target: string;
  directory: string;
  now?: () => Date;
  event?: (severity: 'info' | 'warning' | 'error', type: EventType, message: string, code?: string) => void;
  /** Ends the App through its normal quit and hands the downloaded update to the platform installer. */
  restartToInstall: () => void;
}

// The GitHub and generic providers report a release without this platform's latest*.yml with this code:
// https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.12/packages/electron-updater/src/providers/GitHubProvider.ts
// https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.12/packages/electron-updater/src/providers/GenericProvider.ts
const NO_RELEASE_FOR_PLATFORM = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';

const EMPTY_STATE: SavedUpdateState = { lastCheckAttemptAt: null, checkedAt: null, installing: null };

/**
 * The device's App update: checking for a newer release, downloading it, and handing it to the
 * installer, all on the person's request; and, on the next start, recording whether the version
 * that was being installed is the one now running.
 */
export class UpdateService implements UpdateAccess {
  private readonly stateFile: string;
  private readonly now: () => Date;
  private state: DeviceUpdateStatus;
  private saved: SavedUpdateState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private lastCheckEvent: string | null = null;
  private checkWork: Promise<DeviceUpdateStatus> | null = null;
  private downloadWork: Promise<DeviceUpdateStatus> | null = null;
  private downloadAbort: AbortController | null = null;
  private saves: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(private readonly options: UpdateServiceOptions) {
    this.stateFile = path.join(options.directory, 'state.json');
    this.now = options.now ?? (() => new Date());
    const available = options.updater.available;
    this.state = {
      phase: 'idle', currentVersion: options.currentVersion, target: options.target, installerAvailable: available,
      offer: null, ready: null, lastAttempt: null, progress: null, lastCheckAttemptAt: null, checkedAt: null,
      message: available ? '尚未檢查更新。' : '此執行環境無法安裝更新。', errorCode: null,
    };
  }

  static async open(options: UpdateServiceOptions): Promise<UpdateService> {
    const service = new UpdateService(options);
    await service.restore();
    return service;
  }

  status(): DeviceUpdateStatus { return structuredClone(this.state); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  check(): Promise<DeviceUpdateStatus> {
    if (this.closed || this.state.phase === 'downloading' || this.state.phase === 'installing') return Promise.resolve(this.status());
    this.checkWork ??= this.performCheck().finally(() => { this.checkWork = null; });
    return this.checkWork;
  }

  async download(selection: UpdateSelection): Promise<DeviceUpdateStatus> {
    if (this.closed || this.state.phase === 'installing') return this.status();
    if (this.checkWork) await this.checkWork;
    const offer = this.state.offer;
    if (!offer) throw new CollectorError('update_not_available', '目前沒有可下載的更新。');
    if (offer.version !== selection.version) throw new CollectorError('update_offer_changed', '可用更新已改變，請重新確認版本後再操作。');
    this.downloadWork ??= this.performDownload(offer).finally(() => { this.downloadWork = null; this.downloadAbort = null; });
    return this.downloadWork;
  }

  async apply(selection: UpdateSelection): Promise<DeviceUpdateStatus> {
    if (this.closed || this.state.phase === 'installing') return this.status();
    const ready = this.state.ready;
    if (!ready) throw new CollectorError('update_not_ready', '請先下載更新。');
    if (ready.version !== selection.version) throw new CollectorError('update_offer_changed', '可下載的更新已改變，請重新確認版本後再操作。');
    this.saved = { ...this.saved, installing: { version: ready.version, failure: null } };
    await this.save();
    this.set({ phase: 'installing', message: `正在安裝 ${ready.version}…`, errorCode: null });
    this.options.restartToInstall();
    return this.status();
  }

  async cancel(): Promise<DeviceUpdateStatus> {
    this.downloadAbort?.abort();
    await this.downloadWork;
    return this.status();
  }

  /** Keeps why the installer did not take over, for the next start to show with the incomplete install. */
  async recordInstallFailure(error: unknown): Promise<void> {
    if (!this.saved.installing) return;
    this.saved = { ...this.saved, installing: { ...this.saved.installing, failure: messageOf(error, '安裝程式沒有接手。') } };
    await this.save();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.downloadAbort?.abort();
    await Promise.allSettled([this.checkWork, this.downloadWork, this.saves]);
  }

  private async performCheck(): Promise<DeviceUpdateStatus> {
    const attemptedAt = this.now().toISOString();
    this.saved = { ...this.saved, lastCheckAttemptAt: attemptedAt };
    await this.save();
    const ready = this.state.ready;
    this.set({ lastCheckAttemptAt: attemptedAt, phase: ready ? 'ready' : 'checking', message: '正在檢查更新…', errorCode: null });
    let offer: UpdateOffer | null;
    try {
      offer = await this.options.updater.check();
    } catch (error) {
      if (codeOf(error) !== NO_RELEASE_FOR_PLATFORM) {
        if (this.closed) return this.status();
        const message = messageOf(error, '無法檢查更新。');
        this.set({ phase: ready ? 'ready' : 'error', message, errorCode: 'update_source_failed' });
        this.emitCheckTransition(`failed:${message}`, 'warning', 'device.update_check_failed', message, 'update_source_failed');
        return this.status();
      }
      offer = null;
    }
    if (this.closed) return this.status();
    const checkedAt = this.now().toISOString();
    this.saved = { ...this.saved, checkedAt };
    await this.save();
    if (!offer) {
      this.lastCheckEvent = 'up_to_date';
      this.set({ checkedAt, offer: null, phase: ready ? 'ready' : 'up_to_date',
        message: ready ? `${ready.version} 已可安裝。` : '已是最新版。', errorCode: null });
      return this.status();
    }
    const message = !ready ? `有新版本 ${offer.version}。`
      : ready.version === offer.version ? `${ready.version} 已可安裝。` : `${ready.version} 已可安裝；另有 ${offer.version} 可下載。`;
    this.set({ checkedAt, offer, phase: ready ? 'ready' : 'available', message, errorCode: null });
    this.emitCheckTransition(`available:${offer.version}`, 'info', 'device.update_available', `有新版本 ${offer.version}。`);
    return this.status();
  }

  private async performDownload(offer: UpdateOffer): Promise<DeviceUpdateStatus> {
    const abort = new AbortController();
    this.downloadAbort = abort;
    this.set({ phase: 'downloading', ready: null, progress: { transferred: 0, total: 0, percent: 0 }, message: '正在下載更新…', errorCode: null });
    try {
      await this.options.updater.download((transferred, total) => {
        const percent = total > 0 ? Math.floor(transferred / total * 100) : 0;
        if (percent !== this.state.progress?.percent || total !== this.state.progress.total) this.set({ progress: { transferred, total, percent } });
      }, abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      this.set({ phase: 'ready', ready: offer, progress: null, message: `${offer.version} 已可安裝。`, errorCode: null });
      this.options.event?.('info', 'device.update_ready', `版本 ${offer.version} 已下載。`);
    } catch (error) {
      if (abort.signal.aborted) {
        this.set({ phase: 'available', progress: null, message: `有新版本 ${offer.version}。`, errorCode: null });
        return this.status();
      }
      const message = messageOf(error, '下載更新失敗。');
      this.set({ phase: 'error', progress: null, message, errorCode: 'update_download_failed' });
      this.options.event?.('error', 'device.update_download_failed', message, 'update_download_failed');
    }
    return this.status();
  }

  private async restore(): Promise<void> {
    this.saved = parseState(await readJsonFile(this.stateFile).catch(() => undefined));
    this.set({ lastCheckAttemptAt: this.saved.lastCheckAttemptAt, checkedAt: this.saved.checkedAt });
    const installing = this.saved.installing;
    if (!installing) return;
    const result = installResult(installing, this.options.currentVersion);
    this.saved = { ...this.saved, installing: null };
    await this.save();
    this.set({ lastAttempt: result, message: result.message });
    if (result.outcome === 'installed') this.options.event?.('info', 'device.update_installed', result.message);
    else this.options.event?.('warning', 'device.update_incomplete', result.message, 'update_incomplete');
  }

  private emitCheckTransition(key: string, severity: 'info' | 'warning', type: EventType, message: string, code?: string): void {
    if (this.lastCheckEvent === key) return;
    this.lastCheckEvent = key;
    this.options.event?.(severity, type, message, code);
  }

  private set(patch: Partial<DeviceUpdateStatus>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private save(): Promise<void> {
    const snapshot = structuredClone(this.saved);
    const next = this.saves.then(() => writeJsonFile(this.stateFile, snapshot));
    this.saves = next.catch(() => undefined);
    return next;
  }
}

function installResult(installing: NonNullable<SavedUpdateState['installing']>, currentVersion: string): UpdateInstallResult {
  if (currentVersion === installing.version) return { version: installing.version, outcome: 'installed', message: `已安裝 ${installing.version}。` };
  const reason = installing.failure ? `：${installing.failure}` : '。';
  return { version: installing.version, outcome: 'incomplete', message: `${installing.version} 未完成安裝${reason}` };
}

function parseState(value: unknown): SavedUpdateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_STATE;
  const item = value as Record<string, unknown>;
  const time = (entry: unknown) => typeof entry === 'string' && Number.isFinite(Date.parse(entry)) ? entry : null;
  const installing = item.installing as Record<string, unknown> | null | undefined;
  return {
    lastCheckAttemptAt: time(item.lastCheckAttemptAt),
    checkedAt: time(item.checkedAt),
    installing: installing && typeof installing.version === 'string'
      ? { version: installing.version, failure: typeof installing.failure === 'string' ? installing.failure : null }
      : null,
  };
}

function codeOf(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function messageOf(error: unknown, fallback: string): string {
  const firstLine = error instanceof Error ? error.message.split('\n')[0]?.trim() : '';
  return firstLine || fallback;
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError, type DeviceUpdateStatus, type UpdateInstallAttempt, type UpdateOffer } from '../core/types.js';
import { readJsonFile, writeJsonFile } from '../core/json-file.js';
import { compareVersions } from './release-index.js';
import type { NativeInstaller, UpdateAccess, UpdateApplyRequest, UpdateIdentity, UpdateSelection, UpdateSource } from './types.js';

interface SavedUpdateState {
  schemaVersion: 1;
  ready: { offer: UpdateOffer; fileName: string } | null;
  attempt: (UpdateInstallAttempt & { previousVersion: string; previousBuildId: string; eventRecorded: boolean }) | null;
}

export interface UpdateServiceOptions {
  identity: UpdateIdentity;
  source: UpdateSource;
  installer: NativeInstaller;
  currentBuildId?: string;
  directory: string;
  request?: typeof fetch;
  now?: () => Date;
  event?: (severity: 'info' | 'warning' | 'error', type: string, message: string, code?: string) => void;
  apply?: (request: UpdateApplyRequest) => void;
}

/** Owns update discovery and verified cached bytes; native installers only receive a pinned ready file. */
export class UpdateService implements UpdateAccess {
  private readonly stateFile: string;
  private readonly cache: string;
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  private state: DeviceUpdateStatus;
  private saved: SavedUpdateState = { schemaVersion: 1, ready: null, attempt: null };
  private packageFile: string | null = null;
  private checkWork: Promise<DeviceUpdateStatus> | null = null;
  private checkAbort: AbortController | null = null;
  private downloadWork: Promise<DeviceUpdateStatus> | null = null;
  private downloadAbort: AbortController | null = null;
  private applyAbort: AbortController | null = null;
  private applyWork: Promise<DeviceUpdateStatus> | null = null;
  private saves: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(private readonly options: UpdateServiceOptions) {
    this.stateFile = path.join(options.directory, 'state.json');
    this.cache = path.join(options.directory, 'cache');
    this.request = options.request ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.state = {
      phase: 'idle', currentVersion: options.identity.version, target: options.identity.target,
      variant: options.identity.variant, installerAvailable: options.installer.available,
      offer: null, ready: null, lastAttempt: null, progress: null, checkedAt: null,
      message: options.installer.available ? '尚未檢查更新。' : '此執行環境無法安裝更新。', errorCode: null,
    };
  }

  static async open(options: UpdateServiceOptions): Promise<UpdateService> {
    const service = new UpdateService(options);
    await mkdir(service.cache, { recursive: true, mode: 0o700 });
    await chmod(options.directory, 0o700).catch(() => undefined);
    await service.restore();
    return service;
  }

  status(): DeviceUpdateStatus { return structuredClone(this.state); }

  check(): Promise<DeviceUpdateStatus> {
    if (this.closed) return Promise.resolve(this.status());
    if (['downloading', 'verifying', 'waiting', 'installing'].includes(this.state.phase)) return Promise.resolve(this.status());
    this.checkWork ??= this.performCheck().finally(() => { this.checkWork = null; });
    return this.checkWork;
  }

  download(selection: UpdateSelection): Promise<DeviceUpdateStatus> {
    if (this.closed) return Promise.resolve(this.status());
    if (this.checkWork) return this.checkWork.then(() => this.download(selection));
    if (this.applyAbort) throw new CollectorError('update_busy', '更新正在等待套用，請先取消或完成。');
    this.assertSelected(this.state.offer, selection);
    this.downloadWork ??= this.performDownload().finally(() => { this.downloadWork = null; this.downloadAbort = null; });
    return this.downloadWork;
  }

  apply(selection: UpdateSelection): Promise<DeviceUpdateStatus> {
    if (this.closed) throw new CollectorError('update_busy', 'App 正在結束。');
    if (this.checkWork) return this.checkWork.then(() => this.apply(selection));
    if (this.downloadWork) throw new CollectorError('update_busy', '更新檔仍在下載或驗證。');
    if (this.applyWork || this.applyAbort) { this.assertSelected(this.state.ready, selection); return this.applyWork ?? Promise.resolve(this.status()); }
    this.applyWork = this.performApply(selection).finally(() => { this.applyWork = null; });
    return this.applyWork;
  }

  private async performApply(selection: UpdateSelection): Promise<DeviceUpdateStatus> {
    const ready = this.state.ready;
    if (!ready || !this.packageFile) throw new CollectorError('update_not_ready', '請先下載並完成更新檔驗證。');
    if (!this.options.installer.available) throw new CollectorError('update_install_unavailable', '此執行環境無法安裝更新。');
    this.assertSelected(ready, selection);
    if (compareVersions(ready.version, this.options.identity.version) <= 0) throw new CollectorError('update_not_ready', '已下載的版本不比目前版本新。');
    const abort = new AbortController();
    this.applyAbort = abort;
    try {
      this.set({ phase: 'verifying', message: '正在重新驗證已下載的更新檔…', errorCode: null });
      if (!await verifyFile(this.packageFile, ready.payload.bytes, ready.payload.sha256)) {
        const invalidFile = this.packageFile;
        this.saved.ready = null; this.packageFile = null; this.set({ ready: null }); await this.save();
        await rm(invalidFile, { force: true });
        throw new CollectorError('update_integrity_failed', '已下載的更新檔已變更，請重新下載。');
      }
      if (this.closed || abort.signal.aborted) throw abort.signal.reason ?? new CollectorError('update_cancelled', 'App 正在結束。');
      await this.options.installer.validate(ready, this.packageFile, abort.signal);
      if (this.closed || abort.signal.aborted) throw abort.signal.reason ?? new CollectorError('update_cancelled', 'App 正在結束。');
    } catch (error) {
      if (this.applyAbort === abort) this.applyAbort = null;
      const problem = updateError(error, 'update_apply_failed', '無法驗證更新檔。');
      if (!this.closed) this.set({ phase: this.state.ready ? 'ready' : this.state.offer ? 'available' : 'error', message: problem.message, errorCode: problem.code });
      throw problem;
    }
    this.set({ phase: 'waiting', message: '正在等待收集與資料寫入安全停止…', errorCode: null });
    let attemptId: string | null = null;
    const request: UpdateApplyRequest = {
      offer: ready, packageFile: this.packageFile, signal: abort.signal,
      recordAttempt: async () => {
        if (this.applyAbort !== abort || abort.signal.aborted) throw abort.signal.reason ?? new CollectorError('update_cancelled', '已取消等待更新。');
        const attempt = { id: randomUUID(), version: ready.version, buildId: ready.buildInfo.buildId, startedAt: this.now().toISOString(),
          finishedAt: null, outcome: 'pending' as const, message: `正在安裝 ${ready.version}。`,
          previousVersion: this.options.identity.version, previousBuildId: this.options.currentBuildId ?? 'unknown', eventRecorded: false };
        attemptId = attempt.id;
        this.saved.attempt = attempt; this.set({ lastAttempt: publicAttempt(attempt) }); await this.save();
      },
      installing: () => this.set({ phase: 'installing', message: '正在交接安裝並重新啟動…', errorCode: null }),
      failed: async (code, message) => {
        if (attemptId && this.saved.attempt?.id === attemptId && this.saved.attempt.outcome === 'pending') {
          this.saved.attempt = { ...this.saved.attempt, outcome: 'failed', finishedAt: this.now().toISOString(), message, eventRecorded: true };
          this.set({ lastAttempt: publicAttempt(this.saved.attempt) }); await this.save();
        }
        if (this.applyAbort !== abort) return;
        this.applyAbort = null;
        this.set({ phase: 'error', message, errorCode: code });
        this.options.event?.('error', 'device.update_install_failed', message, code);
      },
    };
    try { this.options.apply?.(request); }
    catch (error) { await request.failed('update_apply_failed', messageOf(error, '無法開始套用更新。')); }
    if (!this.options.apply) await request.failed('update_install_unavailable', '此執行環境沒有更新協調器。');
    return this.status();
  }

  async cancel(): Promise<DeviceUpdateStatus> {
    if (this.downloadAbort) {
      this.downloadAbort.abort(new CollectorError('update_cancelled', '已取消下載更新。'));
      await this.downloadWork?.catch(() => undefined);
    }
    if (this.applyAbort && (this.state.phase === 'waiting' || this.state.phase === 'verifying')) {
      this.applyAbort.abort(new CollectorError('update_cancelled', '已取消等待，更新檔仍保留。'));
      await this.applyWork?.catch(() => undefined);
      this.applyAbort = null;
      this.set({ phase: 'ready', message: `${this.state.ready?.version ?? '更新'} 已準備好。`, errorCode: null });
    }
    return this.status();
  }

  /** Explicit application exit never installs and never resumes a partial transfer next start. */
  async close(): Promise<void> {
    this.closed = true;
    this.checkAbort?.abort(new CollectorError('update_cancelled', 'App 正在結束。'));
    await Promise.allSettled([this.checkWork, this.cancel(), this.applyWork, this.saves]);
  }

  private async performCheck(): Promise<DeviceUpdateStatus> {
    const abort = new AbortController(); this.checkAbort = abort;
    this.set({ phase: this.state.ready ? 'ready' : 'checking', message: '正在檢查更新…', errorCode: null });
    try {
      const offer = await this.options.source.check(this.options.identity, abort.signal);
      if (this.closed || abort.signal.aborted) return this.status();
      const checkedAt = this.now().toISOString();
      if (!offer) {
        this.set({ checkedAt, offer: null, phase: this.state.ready ? 'ready' : 'up_to_date',
          message: this.state.ready ? `${this.state.ready.version} 已準備好。` : '已是最新版。', errorCode: null });
      } else {
        this.set({ checkedAt, offer, phase: this.state.ready ? 'ready' : 'available',
          message: this.state.ready ? `${this.state.ready.version} 已準備好；另有 ${offer.version} 可下載。` : `有新版本 ${offer.version}。`, errorCode: null });
        this.options.event?.('info', 'device.update_available', `有新版本 ${offer.version}。`);
      }
    } catch (error) {
      if (this.closed || abort.signal.aborted) return this.status();
      const problem = updateError(error, 'update_source_failed', '無法檢查更新。');
      this.set({ phase: this.state.ready ? 'ready' : 'error', message: problem.message, errorCode: problem.code });
      this.options.event?.('warning', 'device.update_check_failed', problem.message, problem.code);
    }
    if (this.checkAbort === abort) this.checkAbort = null;
    return this.status();
  }

  private async performDownload(): Promise<DeviceUpdateStatus> {
    const offer = this.state.offer;
    if (!offer) throw new CollectorError('update_not_available', '目前沒有可下載的更新。');
    if (this.state.ready?.version === offer.version && this.packageFile) return this.status();
    const abort = new AbortController(); this.downloadAbort = abort;
    const temporary = path.join(this.cache, `${randomUUID()}.part`);
    const destination = path.join(this.cache, `${offer.payload.sha256.slice(0, 16)}-${path.basename(offer.payload.name)}`);
    this.set({ phase: 'downloading', progress: { transferred: 0, total: offer.payload.bytes, percent: 0 }, message: '正在下載更新…', errorCode: null });
    try {
      const response = await this.request(offer.payload.url, { signal: abort.signal, redirect: 'follow', credentials: 'omit', headers: { Accept: 'application/octet-stream' } });
      if (!response.ok || !response.body) throw new CollectorError('update_download_failed', `更新下載回應 ${response.status}。`);
      assertSafeDownloadUrl(response.url || offer.payload.url);
      const output = await open(temporary, 'wx', 0o600); const hash = createHash('sha256'); let transferred = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          transferred += part.value.byteLength;
          if (transferred > offer.payload.bytes) throw new CollectorError('update_integrity_failed', '更新檔大小超過索引記錄。');
          const bytes = Buffer.from(part.value); hash.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const written = await output.write(bytes, offset, bytes.length - offset);
            if (written.bytesWritten === 0) throw new CollectorError('update_download_failed', '無法寫入更新檔。');
            offset += written.bytesWritten;
          }
          this.set({ progress: { transferred, total: offer.payload.bytes, percent: Math.floor(transferred / offer.payload.bytes * 100) } });
        }
        await output.sync();
      } finally { await output.close(); }
      this.set({ phase: 'verifying', message: '正在驗證更新檔…' });
      if (transferred !== offer.payload.bytes || hash.digest('hex') !== offer.payload.sha256) {
        throw new CollectorError('update_integrity_failed', '下載的更新檔大小或 SHA-256 不符。');
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      await rename(temporary, destination);
      await this.options.installer.validate(offer, destination, abort.signal);
      if (abort.signal.aborted) { await rm(destination, { force: true }); throw abort.signal.reason; }
      const old = this.packageFile;
      this.packageFile = destination; this.saved.ready = { offer, fileName: path.basename(destination) };
      this.set({ phase: 'ready', ready: offer, progress: null, message: `${offer.version} 已準備好。`, errorCode: null });
      await this.save();
      if (old && old !== destination) await rm(old, { force: true });
      this.options.event?.('info', 'device.update_ready', `版本 ${offer.version} 已下載並驗證。`);
    } catch (error) {
      await rm(temporary, { force: true });
      if (this.packageFile !== destination) await rm(destination, { force: true });
      const problem = updateError(error, 'update_download_failed', '下載更新失敗。');
      const cancelled = problem.code === 'update_cancelled';
      this.set({ phase: this.state.ready ? 'ready' : cancelled && this.state.offer ? 'available' : 'error', progress: null,
        message: this.state.ready ? `${this.state.ready.version} 仍已準備好；${problem.message}` : problem.message,
        errorCode: cancelled ? null : problem.code });
      this.options.event?.(problem.code === 'update_cancelled' ? 'info' : 'error', 'device.update_download_failed', problem.message, problem.code);
    }
    return this.status();
  }

  private async restore(): Promise<void> {
    try {
      const value = await readJsonFile(this.stateFile) as Partial<SavedUpdateState> | undefined;
      if (!value) { await this.save(); return; }
      if (value.schemaVersion !== 1 || !('ready' in value) || !('attempt' in value)
        || Object.keys(value).some((key) => !['schemaVersion', 'ready', 'attempt'].includes(key))) throw new Error('unsupported state');
      this.saved = { schemaVersion: 1, ready: value.ready ?? null, attempt: parseAttempt(value.attempt) };
      await this.reconcileAttempt();
      if (!this.saved.ready) return;
      const offer = this.saved.ready.offer;
      const file = path.join(this.cache, path.basename(this.saved.ready.fileName));
      if (!sameIdentity(offer, this.options.identity)) throw new Error('ready cache is invalid');
      if (compareVersions(offer.version, this.options.identity.version) <= 0) {
        this.saved.ready = null; await this.save(); return;
      }
      if (!await verifyFile(file, offer.payload.bytes, offer.payload.sha256)) throw new Error('ready cache is invalid');
      await this.options.installer.validate(offer, file);
      this.packageFile = file; this.set({ phase: 'ready', ready: offer, offer, message: `${offer.version} 已準備好。`, errorCode: null });
    } catch {
      this.saved.ready = null; this.packageFile = null; await this.save();
      this.set({ phase: 'idle', ready: null, message: '已清除無效的更新快取，請重新下載。', errorCode: null });
    }
  }

  private async reconcileAttempt(): Promise<void> {
    const attempt = this.saved.attempt;
    if (!attempt) return;
    const expectedBuildIsRunning = this.options.identity.version === attempt.version && this.options.currentBuildId === attempt.buildId;
    if (attempt.outcome === 'pending' && !expectedBuildIsRunning) {
      this.saved.attempt = { ...attempt, outcome: 'unknown', finishedAt: this.now().toISOString(),
        message: `無法確認 ${attempt.version} 的安裝結果。`, eventRecorded: false };
      await this.save();
    }
    this.set({ lastAttempt: publicAttempt(this.saved.attempt!) });
  }

  /** Called only after the Collector runtime, UI and native restart acknowledgement are ready. */
  async confirmRunningBuild(): Promise<void> {
    const attempt = this.saved.attempt;
    if (!attempt) return;
    if ((attempt.outcome === 'pending' || attempt.outcome === 'unknown') && this.options.identity.version === attempt.version
      && this.options.currentBuildId === attempt.buildId) {
      this.saved.attempt = { ...attempt, outcome: 'succeeded', finishedAt: this.now().toISOString(),
        message: `已安裝 ${attempt.version}。`, eventRecorded: true };
      await this.save(); this.set({ ...(this.state.phase === 'idle' ? { message: this.saved.attempt.message } : {}),
        lastAttempt: publicAttempt(this.saved.attempt) });
      this.options.event?.('info', 'device.update_installed', this.saved.attempt.message);
    } else if (!attempt.eventRecorded && attempt.outcome === 'unknown') {
      this.saved.attempt = { ...attempt, eventRecorded: true };
      await this.save(); this.set({ lastAttempt: publicAttempt(this.saved.attempt) });
      this.options.event?.('warning', 'device.update_outcome_unknown', this.saved.attempt.message, 'update_outcome_unknown');
    }
  }

  private assertSelected(offer: UpdateOffer | null, selection: UpdateSelection): asserts offer is UpdateOffer {
    if (!offer || offer.version !== selection.version || offer.payload.sha256 !== selection.sha256) {
      throw new CollectorError('update_offer_changed', '可用更新已改變，請重新確認版本後再操作。');
    }
  }
  private set(patch: Partial<DeviceUpdateStatus>): void { this.state = { ...this.state, ...patch }; }
  private save(): Promise<void> {
    const snapshot = structuredClone(this.saved);
    const next = this.saves.then(() => writeJsonFile(this.stateFile, snapshot));
    this.saves = next.catch(() => undefined); return next;
  }
}

async function verifyFile(file: string, bytes: number, digest: string): Promise<boolean> {
  try {
    if ((await stat(file)).size !== bytes) return false;
    const hash = createHash('sha256'); for await (const part of createReadStream(file)) hash.update(part);
    return hash.digest('hex') === digest;
  } catch { return false; }
}
function sameIdentity(offer: UpdateOffer, identity: UpdateIdentity): boolean { return offer.target === identity.target && offer.variant === identity.variant; }
function parseAttempt(value: unknown): SavedUpdateState['attempt'] {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid attempt');
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.version !== 'string' || typeof item.buildId !== 'string'
    || typeof item.startedAt !== 'string' || !(item.finishedAt === null || typeof item.finishedAt === 'string')
    || !['pending', 'succeeded', 'failed', 'unknown'].includes(String(item.outcome)) || typeof item.message !== 'string'
    || typeof item.previousVersion !== 'string' || typeof item.previousBuildId !== 'string' || typeof item.eventRecorded !== 'boolean') throw new Error('invalid attempt');
  return item as unknown as NonNullable<SavedUpdateState['attempt']>;
}
function publicAttempt(attempt: NonNullable<SavedUpdateState['attempt']>): UpdateInstallAttempt {
  const { previousVersion: _previousVersion, previousBuildId: _previousBuildId, eventRecorded: _eventRecorded, ...visible } = attempt;
  return visible;
}
function updateError(error: unknown, code: string, fallback: string): CollectorError {
  if (error instanceof CollectorError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new CollectorError('update_cancelled', '已取消更新。', { cause: error });
  return new CollectorError(code, messageOf(error, fallback), { cause: error instanceof Error ? error : undefined });
}
function messageOf(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
function assertSafeDownloadUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return;
  throw new CollectorError('update_source_failed', '更新下載重新導向到不安全的網址。');
}

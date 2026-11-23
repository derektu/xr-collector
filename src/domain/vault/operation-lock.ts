import { CollectorError, type CollectorErrorCode } from '../../shared/lib/collector-error.js';
import type { TransferOperation, TransferResult, TransferStatus } from '../../shared/vault/vault-types.js';

export type OperationStatus = Omit<TransferStatus, 'vaultPath' | 'relocationUnavailable'>;
type ProgressState = Exclude<OperationStatus['state'], 'idle' | 'completed' | 'error'>;

export interface OperationTerminal {
  message: string;
  result?: TransferResult | null;
  errorCode?: CollectorErrorCode | null;
}

export interface OperationCompletion<T> extends OperationTerminal { value: T }

export interface OperationReporter {
  progress(state: ProgressState, message: string, files?: { completed: number; total: number }): void;
  files(completed: number, total?: number): void;
}

interface OperationRun<T> {
  operation: TransferOperation;
  body: (reporter: OperationReporter) => Promise<OperationCompletion<T>>;
  failed: (error: unknown) => OperationTerminal;
}

interface LockDependencies {
  hold(signal?: AbortSignal): Promise<() => void>;
  idle(): Promise<void>;
  suspend(value: boolean): void;
  changed?: () => void;
}

interface UpdateContext { releaseHold: (() => void) | null; transferred: boolean; signal: AbortSignal }

export interface UpdateLease {
  cancel(): void;
  /** Keeps the gate held while the runtime destructively closes; it must never be resumed afterwards. */
  transferToShutdown(): void;
}

export class VaultOperationLock {
  private current: OperationStatus = {
    state: 'idle', operation: null, message: '', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
  };
  private get value(): OperationStatus { return this.current; }
  private set value(next: OperationStatus) {
    this.current = next;
    this.dependencies.changed?.();
  }
  private running = false;
  private releaseHold: (() => void) | null = null;
  private writes = 0;
  private readonly writeWaiters = new Set<() => void>();
  private updateContext: UpdateContext | null = null;
  private active: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: LockDependencies) {}

  status(): OperationStatus { return { ...this.value }; }
  finished(): Promise<void> { return this.active; }
  isLocked(): boolean { return this.running; }

  enterWrite(): () => void {
    if (this.running) throw this.busyWrite();
    if (this.updateContext) throw new CollectorError('update_busy', '正在準備安裝更新，暫時不能寫入知識庫。');
    this.writes += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writes -= 1;
      if (this.writes === 0) { for (const resolve of this.writeWaiters) resolve(); this.writeWaiters.clear(); }
    };
  }

  async prepareUpdate(signal: AbortSignal): Promise<UpdateLease> {
    if (this.running || this.updateContext) throw this.busyWrite();
    const context: UpdateContext = { releaseHold: null, transferred: false, signal };
    this.updateContext = context;
    this.dependencies.suspend(true);
    try {
      const release = await this.dependencies.hold(signal);
      if (signal.aborted) { release(); throw signal.reason; }
      context.releaseHold = release;
      if (this.writes > 0) await abortable(new Promise<void>((resolve) => this.writeWaiters.add(resolve)), signal);
      await abortable(this.dependencies.idle(), signal);
      if (signal.aborted) throw signal.reason;
    } catch (error) {
      this.releaseUpdate(context);
      throw error;
    }
    let finished = false;
    return {
      cancel: () => { if (finished) return; finished = true; this.releaseUpdate(context); },
      transferToShutdown: () => {
        if (finished || this.updateContext !== context) throw new CollectorError('update_busy', '更新等待已經結束。');
        if (context.signal.aborted) { finished = true; this.releaseUpdate(context); throw context.signal.reason; }
        finished = true; context.transferred = true;
      },
    };
  }

  start<T>(run: OperationRun<T>): Promise<T> {
    this.acquire(run.operation);
    let resolveFinished!: () => void;
    this.active = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const task = this.perform(run).finally(resolveFinished);
    void task.catch(() => undefined);
    return task;
  }

  setIdle(message: string): void {
    if (this.running) throw this.busyWrite();
    this.value = { state: 'idle', operation: null, message, completedFiles: 0, totalFiles: 0, result: null, errorCode: null };
  }

  private acquire(operation: TransferOperation): void {
    if (this.updateContext) throw new CollectorError('update_busy', '正在準備安裝更新，請稍後再試。');
    if (this.running || this.writes) {
      throw new CollectorError('vault_busy', '正在進行其他知識庫操作，請等它完成後再試。');
    }
    this.running = true;
    this.dependencies.suspend(true);
    this.value = {
      state: 'waiting', operation, message: '正在等待目前的收集步驟完成…', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
    };
  }

  private async perform<T>(run: OperationRun<T>): Promise<T> {
    const reporter: OperationReporter = {
      progress: (state, message, files) => {
        this.value = { ...this.value, state, message, ...(files ? { completedFiles: files.completed, totalFiles: files.total } : {}) };
      },
      files: (completed, total) => {
        this.value = { ...this.value, completedFiles: completed, ...(total === undefined ? {} : { totalFiles: total }) };
      },
    };
    try {
      this.releaseHold = await this.dependencies.hold();
      await this.dependencies.idle();
      const completed = await run.body(reporter);
      this.release();
      this.value = {
        ...this.value, state: 'completed', message: completed.message, result: completed.result ?? null, errorCode: completed.errorCode ?? null,
      };
      return completed.value;
    } catch (error) {
      this.release();
      const failed = run.failed(error);
      this.value = {
        ...this.value, state: 'error', message: failed.message, result: failed.result ?? null,
        errorCode: failed.errorCode ?? (error instanceof CollectorError ? error.code : null),
      };
      throw error;
    }
  }

  private release(): void {
    const releaseHold = this.releaseHold;
    this.releaseHold = null;
    this.running = false;
    this.dependencies.suspend(false);
    releaseHold?.();
  }

  private busyWrite(): CollectorError {
    if (this.updateContext) return new CollectorError('update_busy', '正在準備安裝更新，請稍後再試。');
    const operation = this.value.operation;
    return new CollectorError('vault_busy', operation === 'open' || operation === 'create' ? '正在切換知識庫，請等它完成後再操作。' : '正在匯出或匯入知識庫，請等它完成後再操作。');
  }

  private releaseUpdate(context: UpdateContext): void {
    if (this.updateContext !== context || context.transferred) return;
    this.updateContext = null;
    this.dependencies.suspend(false);
    context.releaseHold?.();
    context.releaseHold = null;
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

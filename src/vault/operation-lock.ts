import { CollectorError, type CollectorErrorCode, type TransferOperation, type TransferResult, type TransferStatus } from '../core/types.js';

export type VaultAccess = 'vault-read' | 'vault-write' | 'device-data' | 'vault-operation';
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
  blockReads(): void;
  /** The held jobs belong to a bundle that has been replaced and will be closed instead of released. */
  discardHold(): void;
  /** Marks a failure that cannot safely resume collection until the process restarts. */
  stop(error: CollectorError): never;
}

interface OperationRun<T> {
  operation: TransferOperation;
  body: (reporter: OperationReporter) => Promise<OperationCompletion<T>>;
  failed: (error: unknown) => OperationTerminal;
  cancelled?: () => void;
}

interface LockDependencies {
  hold(signal: AbortSignal): Promise<() => void>;
  idle(): Promise<void>;
  suspend(value: boolean): void;
  /** Hears each change of the status once `status()` returns it. */
  changed?: () => void;
}

interface RunContext {
  abort: AbortController | null;
  releaseHold: (() => void) | null;
  blockReading: boolean;
  cancelled: boolean;
  cancellation: CollectorError | null;
  cancelledEvent: (() => void) | null;
}

interface UpdateContext { releaseHold: (() => void) | null; transferred: boolean; signal: AbortSignal }

export interface UpdateLease {
  cancel(): void;
  /** Keeps the gate held while the runtime destructively closes; it must never be resumed afterwards. */
  transferToShutdown(): void;
}

type Lifecycle = { kind: 'idle' } | { kind: 'running'; context: RunContext } | { kind: 'stopped'; context: RunContext };

class StoppedOperation extends Error {
  constructor(readonly problem: CollectorError) { super(problem.message, { cause: problem }); }
}

/**
 * Owns the single Vault operation and every state it exposes. A terminal state is published only
 * after collection and ordinary writes can resume, except for an explicitly stopped operation.
 */
export class VaultOperationLock {
  private current: OperationStatus = {
    state: 'idle', operation: null, message: '', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
  };
  private get value(): OperationStatus { return this.current; }
  private set value(next: OperationStatus) {
    this.current = next;
    this.dependencies.changed?.();
  }
  private lifecycle: Lifecycle = { kind: 'idle' };
  private writes = 0;
  private readonly writeWaiters = new Set<() => void>();
  private updateContext: UpdateContext | null = null;
  private active: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: LockDependencies) {}

  status(): OperationStatus { return { ...this.value }; }
  /** Resolves after the operation active when this is called has published its terminal state. */
  finished(): Promise<void> { return this.active; }
  isLocked(): boolean { return this.lifecycle.kind !== 'idle'; }

  enter(access: VaultAccess): () => void {
    if (access === 'device-data' || access === 'vault-operation') return () => undefined;
    if (access === 'vault-read') {
      if (this.lifecycle.kind !== 'idle' && this.lifecycle.context.blockReading) {
        throw new CollectorError('vault_busy', '正在套用匯入的內容，請稍後再讀取。');
      }
      return () => undefined;
    }
    if (this.lifecycle.kind !== 'idle') throw this.busyWrite();
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

  /** Atomically excludes Vault operations/new writes, then drains existing writes and collection. */
  async prepareUpdate(signal: AbortSignal): Promise<UpdateLease> {
    if (this.lifecycle.kind !== 'idle' || this.updateContext) throw this.busyWrite();
    const context: UpdateContext = { releaseHold: null, transferred: false, signal };
    this.updateContext = context;
    this.dependencies.suspend(true);
    try {
      // JobManager.hold increments its dispatch gate before its first await. Acquire it first so
      // queued work cannot start while existing request writes drain.
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
        // The runtime now owns a destructive close. Keep the gate and hold in force; jobs.close()
        // consumes them, and a close failure must not claim the old runtime resumed safely.
      },
    };
  }

  start<T>(run: OperationRun<T>): Promise<T> {
    const context = this.acquire(run.operation, run.cancelled);
    let resolveFinished!: () => void;
    this.active = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const task = this.perform(run, context).finally(resolveFinished);
    // Background operations deliberately do not await the task; their result is exposed by status.
    void task.catch(() => undefined);
    return task;
  }

  cancelWait(): OperationStatus {
    if (this.lifecycle.kind !== 'running' || !this.lifecycle.context.abort) {
      throw new CollectorError('invalid_request', '目前沒有等待中的知識庫操作；已開始的處理無法取消。');
    }
    const context = this.lifecycle.context;
    const abort = context.abort!;
    const cancellation = new CollectorError('transfer_cancelled', '已取消，資料未變更。');
    context.cancelled = true;
    context.cancellation = cancellation;
    abort.abort(cancellation);
    context.abort = null;
    this.release(context);
    this.value = {
      state: 'idle', operation: null, message: '已取消，資料未變更。', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
    };
    const cancelledEvent = context.cancelledEvent;
    context.cancelledEvent = null;
    try { cancelledEvent?.(); } catch (error) { console.error('Recording a cancelled Vault operation failed', error); }
    return this.status();
  }

  setIdle(message: string): void {
    if (this.lifecycle.kind !== 'idle') throw this.busyWrite();
    this.value = { state: 'idle', operation: null, message, completedFiles: 0, totalFiles: 0, result: null, errorCode: null };
  }

  private acquire(operation: TransferOperation, cancelledEvent?: () => void): RunContext {
    if (this.updateContext) throw new CollectorError('update_busy', '正在準備安裝更新，請稍後再試。');
    if (this.lifecycle.kind !== 'idle' || this.writes) {
      throw new CollectorError('vault_busy', '正在進行其他知識庫操作，請等它完成後再試。');
    }
    const context: RunContext = {
      abort: null, releaseHold: null, blockReading: false, cancelled: false, cancellation: null,
      cancelledEvent: cancelledEvent ?? null,
    };
    this.lifecycle = { kind: 'running', context };
    this.dependencies.suspend(true);
    this.value = {
      state: 'waiting', operation, message: '正在等待目前的收集步驟完成…', completedFiles: 0, totalFiles: 0, result: null, errorCode: null,
    };
    return context;
  }

  private async perform<T>(run: OperationRun<T>, context: RunContext): Promise<T> {
    const ownsLock = () => this.lifecycle.kind !== 'idle' && this.lifecycle.context === context;
    const reporter: OperationReporter = {
      progress: (state, message, files) => {
        if (!ownsLock()) return;
        this.value = { ...this.value, state, message, ...(files ? { completedFiles: files.completed, totalFiles: files.total } : {}) };
      },
      files: (completed, total) => {
        if (!ownsLock()) return;
        this.value = { ...this.value, completedFiles: completed, ...(total === undefined ? {} : { totalFiles: total }) };
      },
      blockReads: () => { if (ownsLock()) context.blockReading = true; },
      discardHold: () => { context.releaseHold = null; },
      stop: (error) => { throw new StoppedOperation(error); },
    };
    try {
      await this.settle(context);
      // The wait can resolve just before cancelWait aborts it. Cancellation still owns that turn,
      // so never let its already-queued continuation enter the operation body.
      if (context.cancelled) throw context.cancellation;
      const completed = await run.body(reporter);
      this.release(context);
      if (this.lifecycle.kind !== 'idle') return completed.value;
      this.value = {
        ...this.value, state: 'completed', message: completed.message, result: completed.result ?? null, errorCode: completed.errorCode ?? null,
      };
      return completed.value;
    } catch (error) {
      if (context.cancelled || error instanceof CollectorError && error.code === 'transfer_cancelled') {
        this.release(context);
        // cancelWait already published idle; this run may unwind after a newer one has finished.
        throw error;
      }
      const stopped = error instanceof StoppedOperation;
      const problem = stopped ? error.problem : error;
      const failed = this.mapFailure(run, problem);
      if (stopped && ownsLock()) this.lifecycle = { kind: 'stopped', context };
      else this.release(context);
      // A superseding operation can exist only after cancellation; never publish over it.
      if (!stopped && this.lifecycle.kind !== 'idle') throw problem;
      this.value = {
        ...this.value, state: 'error', message: failed.message, result: failed.result ?? null,
        errorCode: failed.errorCode ?? (problem instanceof CollectorError ? problem.code : null),
      };
      throw problem;
    }
  }

  private mapFailure<T>(run: OperationRun<T>, problem: unknown): OperationTerminal {
    try { return run.failed(problem); } catch (mappingError) {
      console.error('Mapping a Vault operation failure failed', mappingError);
      return {
        message: problem instanceof CollectorError ? problem.message : '操作失敗，請確認匯出檔、磁碟空間與搜尋服務後重試。',
        result: null, errorCode: problem instanceof CollectorError ? problem.code : null,
      };
    }
  }

  private async settle(context: RunContext): Promise<void> {
    const abort = new AbortController();
    context.abort = abort;
    try {
      const release = await this.dependencies.hold(abort.signal);
      if (abort.signal.aborted) {
        release();
        throw abort.signal.reason;
      }
      context.releaseHold = release;
      await abortable(this.dependencies.idle(), abort.signal);
    } finally {
      if (context.abort === abort) context.abort = null;
    }
  }

  private release(context: RunContext): void {
    const releaseHold = context.releaseHold;
    context.releaseHold = null;
    context.blockReading = false;
    if (this.lifecycle.kind === 'idle' || this.lifecycle.context !== context) {
      releaseHold?.();
      return;
    }
    this.lifecycle = { kind: 'idle' };
    this.dependencies.suspend(false);
    releaseHold?.();
  }

  private busyWrite(): CollectorError {
    if (this.updateContext) return new CollectorError('update_busy', '正在準備安裝更新，請稍後再試。');
    const operation = this.value.operation;
    return new CollectorError('vault_busy', operation === 'move' ? '正在搬移知識庫，請等搬移完成後再操作。'
      : operation === 'open' ? '正在開啟其他知識庫，請等它完成後再操作。' : '正在匯出或匯入知識庫，請等它完成後再操作。');
  }

  private releaseUpdate(context: UpdateContext): void {
    if (this.updateContext !== context || context.transferred) return;
    this.updateContext = null;
    this.dependencies.suspend(false);
    context.releaseHold?.();
    context.releaseHold = null;
  }
}

/** Settles with `work`, or rejects with the signal's reason once it is aborted. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

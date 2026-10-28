import type { CollectorRuntime } from '../runtime/collector-runtime.js';
import type { NativeInstaller, UpdateApplyRequest } from '../updates/types.js';

export interface UpdateCoordinatorHooks {
  shutdownOwned(): void;
  completed(): void;
  terminalFailure(error: Error): Promise<void> | void;
}

/** Coordinates the cancellable drain and the irreversible runtime-close/native-handoff boundary. */
export async function runUpdateCoordinator(
  request: UpdateApplyRequest,
  installer: NativeInstaller,
  runtime: Pick<CollectorRuntime, 'prepareUpdate' | 'close'>,
  hooks: UpdateCoordinatorHooks,
  timeoutMs = 120_000,
): Promise<void> {
  const controller = new AbortController();
  const cancelled = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', cancelled, { once: true });
  if (request.signal.aborted) cancelled();
  const timeout = setTimeout(() => controller.abort(new Error('準備更新超過兩分鐘，已取消本次安裝；App 仍可使用，請稍後重試。')), timeoutMs);
  let lease: Awaited<ReturnType<CollectorRuntime['prepareUpdate']>> | null = null;
  let prepared: Awaited<ReturnType<NativeInstaller['prepare']>> | null = null;
  let transferred = false;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    lease = await runtime.prepareUpdate(controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    prepared = await installer.prepare(request.offer, request.packageFile, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    await request.recordAttempt(prepared.recoveryToken);
    if (controller.signal.aborted) throw controller.signal.reason;
    lease.transferToShutdown();
    transferred = true;
    hooks.shutdownOwned();
    clearTimeout(timeout);
    request.installing();
    await within(runtime.close(), timeoutMs, '關閉資料服務超過兩分鐘，未交接安裝；請重新開啟 App 後再試。');
    await prepared.handoff();
    hooks.completed();
  } catch (error) {
    await prepared?.cancel().catch(() => undefined);
    if (!transferred) lease?.cancel();
    // Before ownership transfers, the coordinator's signal is the authoritative reason for
    // cancellation. A dependency commonly rejects with a generic AbortError and would otherwise
    // hide whether the user cancelled or the two-minute safety deadline elapsed. After transfer,
    // preserve the concrete close/handoff failure because the old runtime is no longer reusable.
    const problem = !transferred && controller.signal.aborted && controller.signal.reason instanceof Error
      ? controller.signal.reason
      : error instanceof Error ? error : new Error('無法安全套用更新。');
    let terminalProblem = problem;
    try { await request.failed('update_apply_failed', problem.message); }
    catch (failure) {
      terminalProblem = new Error(`${problem.message}（安裝失敗狀態也無法保存：${failure instanceof Error ? failure.message : '未知錯誤'}）`);
    }
    if (transferred) await hooks.terminalFailure(terminalProblem);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', cancelled);
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

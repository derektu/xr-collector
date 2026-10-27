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
  const timeout = setTimeout(() => controller.abort(new Error('等待安全停止超過兩分鐘。')), timeoutMs);
  let lease: Awaited<ReturnType<CollectorRuntime['prepareUpdate']>> | null = null;
  let prepared: Awaited<ReturnType<NativeInstaller['prepare']>> | null = null;
  let transferred = false;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    lease = await runtime.prepareUpdate(controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    prepared = await installer.prepare(request.offer, request.packageFile, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    await request.recordAttempt();
    if (controller.signal.aborted) throw controller.signal.reason;
    lease.transferToShutdown();
    transferred = true;
    hooks.shutdownOwned();
    clearTimeout(timeout);
    request.installing();
    await runtime.close();
    await prepared.handoff();
    hooks.completed();
  } catch (error) {
    await prepared?.cancel().catch(() => undefined);
    if (!transferred) lease?.cancel();
    const problem = error instanceof Error ? error : new Error('無法安全套用更新。');
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

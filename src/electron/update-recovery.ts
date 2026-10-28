import type { NativeInstaller, NativeInstallRecovery } from '../updates/types.js';

/** Native journals remain until the matching result is durably recorded by the update service. */
export async function recoverNativeInstallations(
  installer: Pick<NativeInstaller, 'recover'>,
  service: { consumeNativeRecovery(result: NativeInstallRecovery): Promise<boolean> },
  report: (error: Error) => void,
): Promise<boolean> {
  if (!installer.recover) return true;
  const recovered = await installer.recover();
  let ready = recovered.launchReady;
  for (const result of recovered.results) {
    try {
      if (await service.consumeNativeRecovery(result)) await result.finalize();
    } catch (error) {
      ready = false;
      report(error instanceof Error ? error : new Error('無法保存或清理更新結果。'));
    }
  }
  return ready;
}

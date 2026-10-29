import { stat } from 'node:fs/promises';
import { appendBuilderTimingEvents } from './stage-timings.mjs';

/**
 * electron-builder hooks that only record timing marks for package-app.mjs. Each export is
 * resolved by its hook name; without XR_PACKAGE_TIMINGS_FILE they record nothing. The Developer
 * ID afterPack hook in mac-signing-hook.mjs records its own afterPack marks and stages.
 */
const mark = (name) => appendBuilderTimingEvents([{ event: 'mark', name, at: Date.now() }]);

export async function beforePack() { await mark('beforePack'); }

export async function afterPack() {
  const at = Date.now();
  await appendBuilderTimingEvents([{ event: 'mark', name: 'afterPack:start', at }, { event: 'mark', name: 'afterPack:end', at }]);
}

export async function afterSign() { await mark('afterSign'); }

export async function artifactBuildStarted(context) {
  await appendBuilderTimingEvents([{ event: 'artifact:start', file: context.file, at: Date.now() }]);
}

export async function artifactBuildCompleted(context) {
  const at = Date.now();
  let bytes;
  try { bytes = (await stat(context.file)).size; } catch { bytes = undefined; }
  await appendBuilderTimingEvents([{ event: 'artifact:end', file: context.file, at, ...(bytes === undefined ? {} : { bytes }) }]);
}

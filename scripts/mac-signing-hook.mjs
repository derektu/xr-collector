import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { signStagedMacRuntimes } from './mac-signing.mjs';
import { appendBuilderTimingEvents, createStageTimer, timerEvents } from './stage-timings.mjs';

const require = createRequire(import.meta.url);
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager.js');
const { serializeToYaml } = require('builder-util');

export default async function signMacRuntimesAfterPack(context) {
  const startedAt = Date.now();
  const timer = createStageTimer();
  try {
    const keychain = (await context.packager.codeSigningInfo.value).keychainFile;
    const identitySha1 = process.env.XR_MAC_SIGNING_IDENTITY_SHA1;
    const expectedTeamId = process.env.XR_MAC_SIGNING_TEAM_ID;
    const sourceRoot = process.env.XR_MAC_SIGNING_SOURCE_ROOT;
    if (!keychain || keychain !== process.env.CSC_KEYCHAIN || !identitySha1 || !expectedTeamId || !sourceRoot) {
      throw new Error('Developer ID afterPack hook is missing its isolated keychain, identity, Team, or source root.');
    }
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    // electron-builder writes app-update.yml on macOS only when a dmg or zip target is built, so a
    // `--dir` pack has none: https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/publish/PublishManager.ts
    const publishConfig = await getAppUpdatePublishConfiguration(context.packager, null, context.arch, true);
    if (publishConfig) await writeFile(path.join(appPath, 'Contents/Resources/app-update.yml'), serializeToYaml(publishConfig));
    return await signStagedMacRuntimes({ appPath, sourceBin: path.join(sourceRoot, 'resources/bin/mac'), identitySha1, expectedTeamId, keychain }, { timer });
  } finally {
    await appendBuilderTimingEvents([
      { event: 'mark', name: 'afterPack:start', at: startedAt },
      ...timerEvents(timer),
      { event: 'mark', name: 'afterPack:end', at: Date.now() },
    ]);
  }
}

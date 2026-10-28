import path from 'node:path';
import { signStagedMacRuntimes } from './mac-signing.mjs';

export default async function signMacRuntimesAfterPack(context) {
  const keychain = (await context.packager.codeSigningInfo.value).keychainFile;
  const identitySha1 = process.env.XR_MAC_SIGNING_IDENTITY_SHA1;
  const expectedTeamId = process.env.XR_MAC_SIGNING_TEAM_ID;
  const sourceRoot = process.env.XR_MAC_SIGNING_SOURCE_ROOT;
  if (!keychain || keychain !== process.env.CSC_KEYCHAIN || !identitySha1 || !expectedTeamId || !sourceRoot) {
    throw new Error('Developer ID afterPack hook is missing its isolated keychain, identity, Team, or source root.');
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  return signStagedMacRuntimes({ appPath, sourceBin: path.join(sourceRoot, 'resources/bin/mac'), identitySha1, expectedTeamId, keychain });
}

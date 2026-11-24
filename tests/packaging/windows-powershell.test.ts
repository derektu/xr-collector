// The environment the build scripts hand to Windows PowerShell (powershell.exe) carries no
// PSModulePath in any letter case, so a PowerShell 7 module path inherited from a pwsh terminal or a
// CI step never reaches it; every other variable passes through.
import { expect, it } from 'vitest';
// @ts-expect-error The script is executable JavaScript without type declarations.
import { windowsPowerShellEnvironment } from '../../scripts/windows-powershell.mjs';

it('drops PSModulePath in every letter case and keeps every other variable', () => {
  const source: NodeJS.ProcessEnv = {
    PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
    PSMODULEPATH: 'a',
    psmodulepath: 'b',
    Path: 'C:\\Windows\\System32',
    XR_KEY_FILE: 'C:\\key',
    PSModulePathExtra: 'kept',
  };
  expect(windowsPowerShellEnvironment(source)).toEqual({
    Path: 'C:\\Windows\\System32',
    XR_KEY_FILE: 'C:\\key',
    PSModulePathExtra: 'kept',
  });
});

// Broken, a PowerShell 7 module path inherited from pwsh or CI reaches Windows PowerShell and the
// build scripts fail.
import { expect, it } from 'vitest';
import { windowsPowerShellEnvironment } from '../../../scripts/lib/windows-powershell.mjs';

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

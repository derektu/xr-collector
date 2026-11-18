// The environment handed to Windows PowerShell (powershell.exe) carries no PSModulePath in any letter
// case, so a PowerShell 7 module path inherited from a pwsh terminal or a CI step never reaches it;
// every other variable passes through. The app and the build scripts each hold a copy of the helper.
import { describe, expect, it } from 'vitest';
import { windowsPowerShellEnvironment as appHelper } from '../../../src/domain/search/windows-powershell.js';
// @ts-expect-error The script is executable JavaScript without type declarations.
import { windowsPowerShellEnvironment as scriptsHelper } from '../../../scripts/windows-powershell.mjs';

const helpers: Array<[string, (environment?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv]> = [
  ['app (src/domain/search)', appHelper],
  ['build scripts (scripts/)', scriptsHelper],
];

describe.each(helpers)('Windows PowerShell environment from the %s helper', (_name, windowsPowerShellEnvironment) => {
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
    expect(source.PSModulePath).toBe('C:\\Program Files\\PowerShell\\7\\Modules');
  });

  it('reads the current process environment by default', () => {
    process.env.XR_PS_HELPER_PROBE = 'present';
    process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
    try {
      const environment = windowsPowerShellEnvironment();
      expect(environment.XR_PS_HELPER_PROBE).toBe('present');
      expect(Object.keys(environment).some((key) => key.toUpperCase() === 'PSMODULEPATH')).toBe(false);
    } finally {
      delete process.env.XR_PS_HELPER_PROBE;
      delete process.env.PSModulePath;
    }
  });
});

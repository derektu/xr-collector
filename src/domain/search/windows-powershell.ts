// The environment for a Windows PowerShell 5.1 child (powershell.exe). A PSModulePath inherited from
// PowerShell 7 (the app started from a pwsh terminal, or by a tool that runs under pwsh) puts
// PowerShell 7's modules first, and Windows PowerShell then auto-loads them for cmdlets such as
// Get-CimInstance; those modules target .NET, not .NET Framework, and fail at the call. Without
// PSModulePath, Windows PowerShell uses its own module path. scripts/windows-powershell.mjs holds the
// same function for the build scripts, which run before src/ is compiled.

/** A copy of `environment` without PSModulePath, in any letter case. */
export function windowsPowerShellEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) if (key.toUpperCase() === 'PSMODULEPATH') delete result[key];
  return result;
}

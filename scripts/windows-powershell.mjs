// The environment for a Windows PowerShell 5.1 child (powershell.exe). A PSModulePath inherited from
// PowerShell 7 (a pwsh terminal, a GitHub Actions step) puts PowerShell 7's modules first, and Windows
// PowerShell then auto-loads them for cmdlets such as Expand-Archive or Get-CimInstance; those modules
// target .NET, not .NET Framework, and fail at the call. Without PSModulePath, Windows PowerShell uses
// its own module path. src/domain/search/windows-powershell.ts holds the same function for the app, which
// cannot import from scripts/.

/** A copy of `environment` without PSModulePath, in any letter case. */
export function windowsPowerShellEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) if (key.toUpperCase() === 'PSMODULEPATH') delete result[key];
  return result;
}

// Windows PowerShell started through an intermediate process inherits PowerShell 7's module paths
// and fails to load shared modules; removing PSModulePath lets it build its own default:
// https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7
export function windowsPowerShellEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) if (key.toUpperCase() === 'PSMODULEPATH') delete result[key];
  return result;
}

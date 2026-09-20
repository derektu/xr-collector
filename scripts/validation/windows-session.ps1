param(
  [ValidateSet('start','status','stop','capture')][string]$Action='start',
  [Parameter(Mandatory=$true)][string]$Workspace,
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')][string]$Scenario,
  [string]$NodePath=(Get-Command node.exe -ErrorAction Stop).Source,
  [switch]$Inline
)
$ErrorActionPreference='Stop'
$Workspace=(Resolve-Path $Workspace).Path
$NodePath=(Resolve-Path $NodePath).Path
$nodeDirectory=Split-Path $NodePath -Parent
$env:PATH="$nodeDirectory;$env:PATH"
$env:npm_execpath=Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
$cli=Join-Path (Split-Path $PSScriptRoot -Parent) 'validation.mjs'
$sha=[System.Security.Cryptography.SHA256]::Create()
$id=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Workspace)))).Replace('-','').Substring(0,16)
$prefix="XRValidation-$id"
if($Inline -or $Action -eq 'status') {
  $arguments=@($cli,$Action,'--workspace',$Workspace)
  if($Action -eq 'capture') {if(!$Scenario){throw 'Capture requires Scenario'};$arguments+=@('--scenario',$Scenario)}
  $logs=Join-Path $Workspace 'state\launcher-logs';New-Item -ItemType Directory -Force $logs|Out-Null
  $log=Join-Path $logs ("$Action-"+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.log')
  $ErrorActionPreference='Continue'
  & $NodePath @arguments *> $log
  $result=$LASTEXITCODE
  Get-Content $log
  if($Action -eq 'stop' -and $result -eq 0) {
    foreach($name in @('start','capture','stop')) {
      if(Get-ScheduledTask -TaskName "$prefix-$name" -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName "$prefix-$name" -Confirm:$false}
    }
  }
  exit $result
}
foreach($value in @($PSCommandPath,$Workspace,$NodePath)){if($value.Contains('"')){throw 'Paths containing quotes are unsupported'}}
$taskName="$prefix-$Action"
if((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State -eq 'Running'){throw 'This action is still running'}
$arguments="-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action $Action -Workspace `"$Workspace`" -NodePath `"$NodePath`" -Inline"
if($Scenario){$arguments+=" -Scenario $Scenario"}
$a=New-ScheduledTaskAction -Execute powershell.exe -Argument $arguments
$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $taskName -Action $a -Principal $p -Settings $s -Force|Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Scheduled $taskName; inspect $Workspace\state\launcher-logs. Scheduling is not a completed validation result."

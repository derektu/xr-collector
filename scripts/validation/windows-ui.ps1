param(
  [Parameter(Mandatory=$true)][ValidateSet('Capture','Stop')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$Checkout,
  [Parameter(Mandatory=$true)][string]$CreatedAt,
  [string]$Output
)
$ErrorActionPreference='Stop'
$p=Get-Process -Id $ProcessId
$expected=Join-Path $Checkout 'node_modules\electron\dist\electron.exe'
if($p.Path -ne $expected -or $p.StartTime.ToUniversalTime() -lt ([DateTime]::Parse($CreatedAt)).ToUniversalTime()){throw 'Process identity changed'}
if($Action -eq 'Stop') {
  if(!$p.CloseMainWindow()){throw 'Could not close the application window normally'}
  if(!$p.WaitForExit(60000)){throw 'Application still running'}
  exit 0
}
if(!$Output){throw 'Capture requires Output'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ValidationWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
[ValidationWindow]::SetProcessDPIAware()|Out-Null
$handle=$p.MainWindowHandle
if($handle -eq 0){throw 'No visible application window; use an unlocked interactive desktop'}
[ValidationWindow]::ShowWindow($handle,9)|Out-Null
$w=New-Object -ComObject WScript.Shell
$w.AppActivate($ProcessId)|Out-Null
[ValidationWindow]::SetForegroundWindow($handle)|Out-Null
Start-Sleep -Milliseconds 700
if([ValidationWindow]::GetForegroundWindow() -ne $handle){throw 'Application is not foreground; unlock the desktop and activate its window'}
$rect=New-Object ValidationWindow+Rect
if(![ValidationWindow]::GetWindowRect($handle,[ref]$rect)){throw 'Cannot read window bounds'}
$width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
if($width -le 0 -or $height -le 0){throw 'Invalid window bounds'}
Add-Type -AssemblyName System.Drawing
$bitmap=New-Object System.Drawing.Bitmap($width,$height)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
  $bitmap.Save($Output,[System.Drawing.Imaging.ImageFormat]::Png)
} finally {$graphics.Dispose();$bitmap.Dispose()}

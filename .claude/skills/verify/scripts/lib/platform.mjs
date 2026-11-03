// What the verify skill asks the operating system: the process table, a process's command line, who
// listens on a port, how to end a process tree, and the machine's own architecture. macOS answers
// through ps, lsof and sysctl; Windows has none of them, so it answers through PowerShell (CIM and
// Get-NetTCPConnection), taskkill and the registry. Callers see the same shapes on both.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const WINDOWS = process.platform === 'win32';

/** A program file name on this platform: `meilisearch` on macOS, `meilisearch.exe` on Windows. */
export const exe = (name) => (WINDOWS ? `${name}.exe` : name);

/** A program's name without the Windows `.exe`, for comparing programs across platforms. */
export const programName = (file) => path.basename(file ?? '').replace(/\.exe$/iu, '');

/** Paths compare case-insensitively on Windows, as its file system does. */
const fold = (value) => (WINDOWS ? String(value).toLowerCase() : String(value));

/** Whether two paths name the same file, by the platform's rules for case. */
export const samePath = (a, b) => Boolean(a) && Boolean(b) && fold(path.resolve(a)) === fold(path.resolve(b));

/** Whether `file` lies inside `folder`. */
export const inside = (file, folder) => Boolean(file) && fold(path.resolve(file)).startsWith(fold(path.resolve(folder) + path.sep));

const BUFFER = 64 * 1024 * 1024;

/** Runs a PowerShell script and returns its standard output as UTF-8. */
function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
    { encoding: 'utf8', maxBuffer: BUFFER, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

// One CIM query lists every process with its parent, executable and command line.
const WINDOWS_PROCESSES = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; executable = $_.ExecutablePath; command = $_.CommandLine } } | ConvertTo-Json -Compress";

const windowsRows = (stdout) => {
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: row.pid, ppid: row.ppid, pgid: null, executable: row.executable ?? null, command: row.command ?? '',
  }));
};

const psRows = (stdout) => stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean);

/**
 * Every process on the machine: { pid, ppid, pgid, executable, command }. macOS lists the
 * executable (`ps` comm) in a second pass, so a process that starts or ends between the two has
 * none; Windows has no process groups, so `pgid` is null there.
 */
export function processTable() {
  if (WINDOWS) return windowsRows(powershell(WINDOWS_PROCESSES));
  const list = (columns) => psRows(execFileSync('ps', ['-A', '-o', columns], { encoding: 'utf8', maxBuffer: BUFFER }));
  const executables = new Map(list('pid=,ppid=,pgid=,comm=').map((match) => [Number(match[1]), match[4]]));
  return list('pid=,ppid=,pgid=,command=').map((match) => ({
    pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), executable: executables.get(Number(match[1])) ?? null, command: match[4],
  }));
}

/** The command line of one process; empty when it is not running. */
export function commandOf(pid) {
  try {
    if (WINDOWS) return powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`).trim();
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** PIDs listening on a TCP port, sorted; empty when nothing listens. */
export function listeners(port) {
  try {
    const stdout = WINDOWS
      ? powershell(`Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }`)
      : execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    return [...new Set(stdout.split(/\s+/u).filter(Boolean).map(Number))].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Ends a Windows process and every process it started, at once (taskkill /T /F). Windows has no
 * signal a console or windowless process could handle as a request to shut down, so this is the
 * only way to end one from outside.
 */
export function endWindowsTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* already gone */ }
}

/** Architecture names as Node spells them. */
const ARCH = { amd64: 'x64', x86_64: 'x64', x64: 'x64', arm64: 'arm64', aarch64: 'arm64', x86: 'ia32' };

let host;

/**
 * The machine's own architecture, which differs from Node's when Node runs under emulation: x64
 * Node on Windows ARM64, or under Rosetta on an Apple silicon Mac. Read once per process.
 */
export function hostArch() {
  host ??= readHostArch();
  return host;
}

function readHostArch() {
  try {
    if (WINDOWS) {
      const stdout = execFileSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'PROCESSOR_ARCHITECTURE'],
        { encoding: 'utf8', windowsHide: true });
      const value = /PROCESSOR_ARCHITECTURE\s+REG_SZ\s+(\S+)/u.exec(stdout)?.[1];
      return ARCH[value?.toLowerCase()] ?? value ?? null;
    }
    if (process.platform === 'darwin') {
      return execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1' ? 'arm64' : 'x64';
    }
  } catch { /* fall through */ }
  return ARCH[os.machine().toLowerCase()] ?? os.machine();
}

/**
 * The machine a run executes on, as results.json records it: platform, OS release and
 * version, Node's architecture, the machine's own architecture, and whether Node is emulated.
 */
export function environment() {
  const machine = hostArch();
  return {
    platform: process.platform, osRelease: os.release(), osVersion: os.version(), node: process.version,
    nodeArch: process.arch, hostArch: machine, emulated: Boolean(machine) && machine !== process.arch,
  };
}

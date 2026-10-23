// What the verify skill asks the operating system: the process table, when a process started, who
// listens on a port, how to end a process tree, and the machine's own architecture. macOS answers
// through ps, lsof and sysctl; Windows has none of them, so it answers through PowerShell (CIM and
// Get-NetTCPConnection), taskkill and the registry. Callers see the same shapes on both.
import { execFile, execFileSync, spawn } from 'node:child_process';
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

// One CIM query lists every process with its parent, executable, command line and start time.
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

/** processTable without blocking: { pid, ppid, executable } only, for sampling while a flow runs. */
export function processTableAsync() {
  return new Promise((resolve, reject) => {
    const done = (parse) => (error, stdout) => (error ? reject(error) : resolve(parse(stdout)));
    if (WINDOWS) {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${WINDOWS_PROCESSES}`],
        { encoding: 'utf8', maxBuffer: BUFFER, windowsHide: true }, done(windowsRows));
      return;
    }
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8', maxBuffer: BUFFER },
      done((stdout) => psRows(stdout).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), executable: match[4] }))));
  });
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

/**
 * When a process started; null when it is not running. A PID plus its start time names one process
 * even after the PID is reused.
 */
export function processStart(pid) {
  try {
    if (WINDOWS) return powershell(`(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`).trim() || null;
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
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
/**
 * Windows: reports each process that starts from now on as { pid, ppid, executable }, through a
 * WMI creation event that PowerShell polls every 0.2 s. A short-lived program such as yt-dlp is seen
 * even though one listing of the whole process table takes seconds. Returns { ready, stop() }; ready
 * resolves once the subscription is in place. stop() ends the watcher once, and only while it is
 * still running: after it exits, its PID may belong to another program, whose tree taskkill would
 * end. `start` and `endTree` replace spawning PowerShell and taskkill in tests.
 */
export function watchWindowsStarts(onStart, { start = startWatcher, endTree = endWindowsTree } = {}) {
  const script = [
    "$query = \"SELECT * FROM __InstanceCreationEvent WITHIN 0.2 WHERE TargetInstance ISA 'Win32_Process'\"",
    'Register-CimIndicationEvent -Query $query -SourceIdentifier xrVerifyStarts | Out-Null',
    "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
    'while ($true) {',
    '  $arrival = Wait-Event -SourceIdentifier xrVerifyStarts',
    '  $started = $arrival.SourceEventArgs.NewEvent.TargetInstance',
    "  [Console]::Out.WriteLine(\"$($started.ProcessId)|$($started.ParentProcessId)|$($started.ExecutablePath)\"); [Console]::Out.Flush()",
    '  Remove-Event -EventIdentifier $arrival.EventIdentifier',
    '}',
  ].join('\n');
  const child = start(script);
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop();
    for (const line of lines) {
      if (line === 'ready') { resolveReady(); continue; }
      const [pid, ppid, executable] = line.split('|');
      if (pid) onStart({ pid: Number(pid), ppid: Number(ppid), executable: executable || null });
    }
  });
  child.once('exit', () => resolveReady());
  let stopped = false;
  return {
    ready,
    stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) endTree(child.pid);
    },
  };
}

/** Runs a PowerShell script in the background with its standard output piped. */
const startWatcher = (script) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

export function endWindowsTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* already gone */ }
}

/** Architecture names as Node spells them. */
const ARCH = { amd64: 'x64', x86_64: 'x64', x64: 'x64', arm64: 'arm64', aarch64: 'arm64', x86: 'ia32' };

/**
 * The machine's own architecture, which differs from Node's when Node runs under emulation: x64
 * Node on Windows ARM64, or under Rosetta on an Apple silicon Mac.
 */
export function hostArch() {
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
 * The machine a run executes on, as results.json and doctor record it: platform, OS release and
 * version, Node's architecture, the machine's own architecture, and whether Node is emulated.
 */
export function environment() {
  const host = hostArch();
  return {
    platform: process.platform, osRelease: os.release(), osVersion: os.version(), node: process.version,
    nodeArch: process.arch, hostArch: host, emulated: Boolean(host) && host !== process.arch,
  };
}

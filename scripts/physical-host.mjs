import { execFile } from 'node:child_process';
import { arch, machine, platform } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const WINDOWS_PROCESSOR_ARCHITECTURES = new Map([
  [9, 'x64'],
  [12, 'arm64'],
]);

/** The physical host behind this Node process; Windows never trusts WOW/environment architecture. */
export async function probePhysicalHost(options = {}) {
  const currentPlatform = options.platform ?? platform();
  const processArch = normalizeArch(options.processArch ?? arch());
  const currentMachine = options.machine ?? machine();
  const run = options.run ?? runCommand;
  let hostArch;

  if (currentPlatform === 'win32') {
    let output;
    try {
      output = (await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '@(Get-CimInstance -ClassName Win32_Processor | ForEach-Object { [int]$_.Architecture }) -join ","',
      ])).stdout;
    } catch (error) {
      throw new Error('Cannot determine the physical Windows processor architecture with CIM.', { cause: error });
    }
    hostArch = parseWindowsProcessorArchitectures(output);
  } else if (currentPlatform === 'darwin') {
    let translated;
    try {
      translated = (await run('sysctl', ['-in', 'sysctl.proc_translated'])).stdout.trim();
    } catch (error) {
      throw new Error('Cannot determine whether the macOS process is translated.', { cause: error });
    }
    // The Rosetta key is absent on Intel Macs; `sysctl -in` reports that as a successful empty result.
    if (translated !== '' && translated !== '0' && translated !== '1') {
      throw new Error(`Cannot determine whether the macOS process is translated: ${translated}.`);
    }
    hostArch = translated === '1' ? 'arm64' : normalizeArch(currentMachine);
  } else {
    hostArch = normalizeArch(currentMachine);
  }

  if (!['arm64', 'x64'].includes(hostArch)) {
    throw new Error(`Unsupported or unknown physical host architecture: ${hostArch || 'empty response'}.`);
  }
  return { platform: currentPlatform, processArch, hostArch, emulated: processArch !== hostArch };
}

export function parseWindowsProcessorArchitectures(output) {
  const values = output.trim().split(/[\s,]+/u).filter(Boolean);
  const codes = new Set(values.map((value) => Number(value)));
  if (values.length === 0 || [...codes].some((value) => !Number.isInteger(value))) {
    throw new Error('CIM returned no usable Windows processor architecture.');
  }
  const architectures = new Set([...codes].map((code) => WINDOWS_PROCESSOR_ARCHITECTURES.get(code)));
  if (architectures.has(undefined) || architectures.size !== 1) {
    throw new Error(`CIM returned unsupported or mixed Windows processor architectures: ${[...codes].join(', ')}.`);
  }
  return [...architectures][0];
}

export function normalizeArch(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64') return 'x64';
  if (normalized === 'aarch64') return 'arm64';
  return normalized;
}

async function runCommand(command, args) {
  const result = await exec(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

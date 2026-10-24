import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The production host probe is intentionally executable JavaScript.
import { parseWindowsProcessorArchitectures, probePhysicalHost } from '../../scripts/physical-host.mjs';

describe('physical build host detection', () => {
  it('uses Windows CIM instead of an emulated x64 Node process', async () => {
    const run = vi.fn(async () => ({ stdout: '12\r\n', stderr: '' }));
    await expect(probePhysicalHost({ platform: 'win32', processArch: 'x64', machine: 'x86_64', run })).resolves.toEqual({
      platform: 'win32', processArch: 'x64', hostArch: 'arm64', emulated: true,
    });
    expect(run).toHaveBeenCalledWith('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '@(Get-CimInstance -ClassName Win32_Processor | ForEach-Object { [int]$_.Architecture }) -join ","',
    ]);
  });

  it('fails closed when Windows CIM cannot establish one supported physical architecture', async () => {
    await expect(probePhysicalHost({
      platform: 'win32', processArch: 'x64', machine: 'x86_64',
      run: async () => { throw new Error('CIM unavailable'); },
    })).rejects.toThrow(/Cannot determine the physical Windows processor architecture/u);
    expect(() => parseWindowsProcessorArchitectures('9,12')).toThrow(/mixed Windows processor architectures/u);
    expect(() => parseWindowsProcessorArchitectures('')).toThrow(/no usable Windows processor architecture/u);
  });

  it('detects an x64 Node process translated on Apple silicon', async () => {
    await expect(probePhysicalHost({
      platform: 'darwin', processArch: 'x64', machine: 'x86_64',
      run: async () => ({ stdout: '1\n', stderr: '' }),
    })).resolves.toEqual({ platform: 'darwin', processArch: 'x64', hostArch: 'arm64', emulated: true });
  });

  it('treats an absent Rosetta key as native Intel, but not a failed probe', async () => {
    await expect(probePhysicalHost({
      platform: 'darwin', processArch: 'x64', machine: 'x86_64',
      run: async () => ({ stdout: '', stderr: 'sysctl: unknown oid' }),
    })).resolves.toEqual({ platform: 'darwin', processArch: 'x64', hostArch: 'x64', emulated: false });
    await expect(probePhysicalHost({
      platform: 'darwin', processArch: 'x64', machine: 'x86_64',
      run: async () => { throw new Error('sysctl unavailable'); },
    })).rejects.toThrow(/Cannot determine whether the macOS process is translated/u);
  });
});

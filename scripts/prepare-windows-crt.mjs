#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readWindowsCrtPin() {
  return JSON.parse(await readFile(path.join(projectRoot, 'scripts', 'runtime-dependency-pins.json'), 'utf8')).officialWindowsCrt;
}

/** The first Visual Studio Redist `vcruntime140.dll` that matches the pin's bytes, version and Microsoft signer, or null. */
export async function findTrustedWindowsCrt(pin, dependencies = {}) {
  const candidates = await (dependencies.findCandidates ?? findCandidates)();
  for (const candidate of candidates) {
    try { if (await isTrustedCrt(candidate, pin, dependencies)) return candidate; } catch { /* examine the next VS Redist candidate */ }
  }
  return null;
}

async function isTrustedCrt(candidate, pin, dependencies) {
  const info = await stat(candidate);
  if (info.size !== pin.bytes || await sha256(candidate) !== pin.sha256) return false;
  const identity = await (dependencies.inspectSignature ?? inspectSignature)(candidate);
  return identity.status === 'Valid'
    && identity.fileVersion === pin.fileVersion
    && identity.subject === pin.signerSubject
    && identity.thumbprint.toUpperCase() === pin.signerThumbprint.toUpperCase();
}

export async function prepareWindowsCrt(options = {}, dependencies = {}) {
  const pin = options.pin ?? await readWindowsCrtPin();
  const destination = options.destination ?? path.join(projectRoot, 'resources', 'bin', 'win', pin.fileName);
  try {
    if (await isTrustedCrt(destination, pin, dependencies)) return { destination, cacheHit: true, pin };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = await findTrustedWindowsCrt(pin, dependencies);
  if (!source) throw new Error(`No trusted pinned Microsoft Visual C++ v14 x64 ${pin.fileName} ${pin.fileVersion} was found; the existing runtime was preserved.`);
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const backup = `${destination}.${process.pid}.bak`;
  let hadExisting = false;
  try {
    await copyFile(source, temp);
    try { await rename(destination, backup); hadExisting = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(temp, destination); }
    catch (error) { if (hadExisting) await rename(backup, destination); throw error; }
    if (hadExisting) await rm(backup, { force: true });
  } finally { await rm(temp, { force: true }); }
  return { destination, cacheHit: false, pin, source };
}

async function findCandidates() {
  if (process.platform !== 'win32') throw new Error('Microsoft Visual C++ runtime preparation is supported only on Windows.');
  const script = [
    "$roots=@($env:ProgramFiles,${env:ProgramFiles(x86)}) | Where-Object { $_ } | Select-Object -Unique",
    "$files=foreach($root in $roots){Get-ChildItem -Path (Join-Path $root 'Microsoft Visual Studio\\*\\*\\VC\\Redist\\MSVC\\*\\x64\\Microsoft.VC*.CRT\\vcruntime140.dll') -File -ErrorAction SilentlyContinue}",
    '$files.FullName | ConvertTo-Json -Compress',
  ].join(';');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function inspectSignature(filePath) {
  const quoted = filePath.replaceAll("'", "''");
  const script = `$p='${quoted}';$s=Get-AuthenticodeSignature -LiteralPath $p;[pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint;fileVersion=(Get-Item -LiteralPath $p).VersionInfo.FileVersion}|ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  return JSON.parse(stdout);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWindowsCrt().then(({ destination }) => console.log(`Prepared pinned app-local Microsoft runtime: ${destination}`)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

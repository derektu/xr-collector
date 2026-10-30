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
  return JSON.parse(await readFile(path.join(projectRoot, 'scripts', 'runtime-dependency-pins.json'), 'utf8')).windowsCrt;
}

/**
 * Checks a `vcruntime140.dll` against the pin: its size and SHA-256, a valid Authenticode signature
 * from the pinned Microsoft signer, and its file version. Throws with the first mismatch.
 */
export async function assertTrustedWindowsCrt(filePath, pin, dependencies = {}) {
  const info = await stat(filePath);
  if (info.size !== pin.bytes) throw new Error(`${filePath} is ${info.size} bytes, expected ${pin.bytes}.`);
  const digest = await sha256(filePath);
  if (digest !== pin.sha256) throw new Error(`${filePath} has SHA-256 ${digest}, expected ${pin.sha256}.`);
  const identity = await (dependencies.inspectSignature ?? inspectSignature)(filePath);
  if (identity.status !== 'Valid' || identity.subject !== pin.signerSubject
    || identity.thumbprint?.toUpperCase() !== pin.signerThumbprint.toUpperCase()) {
    throw new Error(`${filePath} does not carry a valid signature from the pinned Microsoft signer (status ${identity.status}, subject ${identity.subject}).`);
  }
  if (identity.fileVersion !== pin.fileVersion) throw new Error(`${filePath} is version ${identity.fileVersion}, expected ${pin.fileVersion}.`);
}

/**
 * Installs the repository's pinned Microsoft Visual C++ runtime beside the Windows Meilisearch in
 * `resources/bin/win`. The Meilisearch Windows release binary imports `vcruntime140.dll`, and the
 * installer ships this app-local copy so the App runs on machines without the VC++ Redistributable.
 */
export async function prepareWindowsCrt(options = {}, dependencies = {}) {
  const pin = options.pin ?? await readWindowsCrtPin();
  const source = options.source ?? path.join(projectRoot, 'resources', 'windows', pin.fileName);
  const destination = options.destination ?? path.join(projectRoot, 'resources', 'bin', 'win', pin.fileName);
  await assertTrustedWindowsCrt(source, pin, dependencies);
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await copyFile(source, temp);
    await rename(temp, destination);
  } finally { await rm(temp, { force: true }); }
  return { source, destination, pin };
}

async function inspectSignature(filePath) {
  if (process.platform !== 'win32') throw new Error('Checking the Microsoft signature of vcruntime140.dll requires Windows.');
  const quoted = filePath.replaceAll("'", "''");
  const script = `$p='${quoted}';$s=Get-AuthenticodeSignature -LiteralPath $p;[pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint;fileVersion=(Get-Item -LiteralPath $p).VersionInfo.FileVersion}|ConvertTo-Json -Compress`;
  // A PSModulePath inherited from PowerShell 7 points Windows PowerShell at modules it cannot load,
  // so Get-AuthenticodeSignature goes missing; without it Windows PowerShell uses its own defaults.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env });
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

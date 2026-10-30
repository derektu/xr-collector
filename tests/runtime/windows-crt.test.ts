import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareWindowsCrt, readWindowsCrtPin } from '../../scripts/prepare-windows-crt.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

it('keeps the pinned vcruntime140.dll in the repository', async () => {
  const pin = await readWindowsCrtPin();
  const bytes = await readFile(path.resolve('resources/windows', pin.fileName));
  expect(bytes.length).toBe(pin.bytes);
  expect(sha256(bytes)).toBe(pin.sha256);
});

it('installs the repository DLL only when its bytes and Microsoft signature match the pin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-crt-'));
  roots.push(root);
  const source = path.join(root, 'repo', 'vcruntime140.dll');
  const destination = path.join(root, 'runtime', 'vcruntime140.dll');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'pinned crt');
  const pin = {
    fileName: 'vcruntime140.dll', bytes: 10, sha256: sha256('pinned crt'), fileVersion: '14.40.33816.0',
    signerSubject: 'Microsoft signer', signerThumbprint: 'ABCDEF',
  };
  const trusted = async () => ({ status: 'Valid', subject: 'Microsoft signer', thumbprint: 'abcdef', fileVersion: '14.40.33816.0' });

  await expect(prepareWindowsCrt({ source, destination, pin }, { inspectSignature: async () => ({ ...await trusted(), thumbprint: 'WRONG' }) }))
    .rejects.toThrow(/pinned Microsoft signer/u);
  await expect(prepareWindowsCrt({ source, destination, pin }, { inspectSignature: async () => ({ ...await trusted(), status: 'HashMismatch' }) }))
    .rejects.toThrow(/pinned Microsoft signer/u);
  await expect(prepareWindowsCrt({ source, destination, pin }, { inspectSignature: async () => ({ ...await trusted(), fileVersion: '14.44.0.0' }) }))
    .rejects.toThrow(/version 14\.44\.0\.0/u);
  await expect(prepareWindowsCrt({ source, destination, pin: { ...pin, sha256: sha256('other') } }, { inspectSignature: trusted }))
    .rejects.toThrow(/SHA-256/u);
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

  await prepareWindowsCrt({ source, destination, pin }, { inspectSignature: trusted });
  expect(await readFile(destination, 'utf8')).toBe('pinned crt');
});

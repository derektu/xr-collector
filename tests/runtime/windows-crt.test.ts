import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareWindowsCrt } from '../../scripts/prepare-windows-crt.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

it('installs only an exactly pinned and trusted VS Redistributable DLL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-crt-'));
  roots.push(root);
  const candidate = path.join(root, 'vs', 'vcruntime140.dll');
  const destination = path.join(root, 'runtime', 'vcruntime140.dll');
  await mkdir(path.dirname(candidate), { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(candidate, 'official crt');
  await writeFile(destination, 'old runtime');
  const pin = {
    fileName: 'vcruntime140.dll', bytes: 12, sha256: sha256('official crt'), fileVersion: '14.40.33816.0',
    signerSubject: 'Microsoft signer', signerThumbprint: 'ABCDEF',
  };
  const trusted = async () => ({ status: 'Valid', subject: 'Microsoft signer', thumbprint: 'ABCDEF', fileVersion: '14.40.33816.0' });

  await expect(prepareWindowsCrt({ destination, pin }, { findCandidates: async () => [candidate], inspectSignature: async () => ({ ...await trusted(), thumbprint: 'WRONG' }) })).rejects.toThrow(/No trusted pinned/u);
  expect(await readFile(destination, 'utf8')).toBe('old runtime');

  await prepareWindowsCrt({ destination, pin }, { findCandidates: async () => [candidate], inspectSignature: trusted });
  expect(await readFile(destination, 'utf8')).toBe('official crt');
});

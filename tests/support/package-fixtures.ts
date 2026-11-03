import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { VAULT_MARKER, writeVaultMarker } from '../../src/vault/vault-directory.js';
import {
  checkPackageContent, MANIFEST, openPackage, PACKAGE_FORMAT, PACKAGE_FORMAT_VERSION, unpackPackage, writePackage, type PackageReader,
} from '../../src/vault/vault-package.js';

/** Package files for tests, held in memory: a package is small there and easier to change. */

export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** The package of a Vault as bytes. */
export async function packageBytes(root: string, info: { createdBy?: string; exportedAt?: Date } = {}): Promise<Buffer> {
  const folder = await mkdtemp(path.join(tmpdir(), 'xr-package-'));
  try {
    const file = path.join(folder, `${randomUUID()}.zip`);
    await writePackage(root, file, info);
    return await readFile(file);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Every entry of a zip, `manifest.json` included. */
export async function zipEntries(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true });
  const result = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const chunks: Buffer[] = [];
    for await (const chunk of await zip.openReadStreamPromise(entry) as AsyncIterable<Buffer>) chunks.push(chunk);
    result.set(entry.fileName, Buffer.concat(chunks));
  }
  zip.close();
  return result;
}

/** The files of a package, without its manifest. */
export async function packageFiles(bytes: Buffer): Promise<Map<string, Buffer>> {
  const entries = await zipEntries(bytes);
  entries.delete(MANIFEST);
  return entries;
}

export async function manifestOf(bytes: Buffer): Promise<Record<string, unknown> & { files: { path: string; size: number; sha256: string }[] }> {
  return JSON.parse((await zipEntries(bytes)).get(MANIFEST)!.toString()) as never;
}

/**
 * Bytes of a zip holding `entries` exactly as given. The writer refuses unsafe names, so such a
 * name is written as a placeholder of the same length and patched into the bytes afterwards.
 */
export async function zipOf(entries: readonly { name: string; data: string | Buffer }[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const patches: [Buffer, Buffer][] = [];
  for (const [index, entry] of entries.entries()) {
    const unsafe = entry.name.startsWith('/') || entry.name.split('/').includes('..');
    const placeholder = unsafe ? `${String(index).padStart(entry.name.length, 'q')}` : entry.name;
    if (unsafe) patches.push([Buffer.from(placeholder), Buffer.from(entry.name)]);
    zip.addBuffer(Buffer.from(entry.data), placeholder, { compress: false });
  }
  zip.end();
  const bytes = await streamBytes(zip.outputStream as unknown as Readable);
  for (const [from, to] of patches) {
    for (let at = bytes.indexOf(from); at >= 0; at = bytes.indexOf(from, at + 1)) to.copy(bytes, at);
  }
  return bytes;
}

/**
 * A package of `files` with a manifest that lists them; `manifest` replaces or adds manifest fields
 * and `extra` adds zip entries the manifest does not list.
 */
export async function packageOf(
  files: readonly { path: string; data: string | Buffer }[],
  manifest: Record<string, unknown> = {},
  extra: readonly { name: string; data: string | Buffer }[] = [],
): Promise<Buffer> {
  const rows = files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.data), sha256: sha(Buffer.from(file.data)) }));
  return zipOf([
    ...files.map((file) => ({ name: file.path, data: file.data })),
    ...extra,
    { name: MANIFEST, data: JSON.stringify({ format: PACKAGE_FORMAT, formatVersion: PACKAGE_FORMAT_VERSION, files: rows, ...manifest }) },
  ]);
}

/** A package with one file changed, its manifest still describing the original. */
export async function tampered(bytes: Buffer, file: string, data: string | Buffer): Promise<Buffer> {
  const entries = await zipEntries(bytes);
  entries.set(file, Buffer.from(data));
  return zipOf([...entries].map(([name, value]) => ({ name, data: value })));
}

export async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Gives a folder the marker of a current Vault unless it has one, so a workspace opens it. */
export async function ensureMarker(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  if (!existsSync(path.join(root, VAULT_MARKER))) await writeVaultMarker(root, 'XR Collector test');
}

/** Runs `use` on package bytes opened as a package file. */
export async function withPackage<T>(bytes: Buffer, use: (reader: PackageReader) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), 'xr-package-'));
  try {
    const file = path.join(folder, 'package.zip');
    await writeFile(file, bytes);
    const reader = await openPackage(file);
    try { return await use(reader); } finally { reader.close(); }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Checks package bytes as an import does and writes their files into `destination`. */
export async function unpackBytes(bytes: Buffer, destination: string): Promise<void> {
  await withPackage(bytes, async (reader) => {
    await checkPackageContent(reader);
    await mkdir(destination, { recursive: true });
    await unpackPackage(reader, destination, () => undefined);
  });
}

import type { SourceRegistry } from './source-registry.js';

/**
 * The way into one Vault's files. Every file the Vault registers (a document, the subscriptions file
 * of a source type, the schedule file and the deletion file) is written through it, and it raises
 * the Vault marker to the format the file needs before the file is written, so a program that only
 * reads an older format never opens a Vault holding files it would misread. Paths are relative to
 * the Vault root with `/` separators. Any other path is refused, so a new kind of Vault file is
 * registered with the format it needs before anything can write it.
 */
export interface VaultFiles {
  /** The Vault folder; reads go to it directly. */
  readonly root: string;
  /** The source types whose documents and subscription files this Vault holds, and its schedule file. */
  readonly sources: SourceRegistry;
  /** Replaces the file with pretty-printed JSON, through a temporary file and a rename. */
  writeJson(relative: string, value: unknown): Promise<void>;
  /** Creates the file with `text` unless it exists; returns whether this call created it. */
  create(relative: string, text: string): Promise<boolean>;
  /** Removes the file; a missing file is already removed. */
  remove(relative: string): Promise<void>;
}

import type { SourceRegistry } from '../sources/source-registry.js';

/**
 * Every write to a file the Vault registers (a document, the subscriptions file of a source type,
 * the schedule file and the deletion file) goes through this. Paths are relative to the Vault root
 * with `/` separators; any other path is refused.
 */
export interface VaultFiles {
  /** The Vault folder; reads go to it directly. */
  readonly root: string;
  readonly sources: SourceRegistry;
  /** Replaces the file with pretty-printed JSON; readers see the old file or the new one, never part of it. */
  writeJson(relative: string, value: unknown): Promise<void>;
  /** Replaces the file with `text`; readers see the old file or the new one, never part of it. */
  writeText(relative: string, text: string): Promise<void>;
  /** Creates the file with `text` unless it exists; returns whether this call created it. */
  create(relative: string, text: string): Promise<boolean>;
  /** Removes the file; a missing file is already removed. */
  remove(relative: string): Promise<void>;
}

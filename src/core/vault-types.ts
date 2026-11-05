import type { CollectorErrorCode } from './collector-error.js';

/** Result of reading a directory before it is created or opened as a Vault. */
export type VaultInspection =
  | { kind: 'empty'; path: string; exists: boolean }
  | { kind: 'existing'; path: string; documentCount: number }
  | { kind: 'invalid'; path: string; reason: string };

/**
 * How Onboarding and Agents make a Vault active while none is: `create` a new Vault folder named
 * `name` in the folder `location`, `open` the existing Vault at `path`, or `import`: create the new
 * folder from the export file at `packagePath`.
 */
export type VaultSetupRequest =
  | { action: 'create'; location: string; name: string }
  | { action: 'open'; path: string }
  | { action: 'import'; location: string; name: string; packagePath: string };

/** A new Vault folder checked before it is created: its path, and why it cannot be created (null when it can). */
export interface NewVaultCheck {
  /** `<location>/<name>`; null when the location or name names no folder. */
  path: string | null;
  problem: string | null;
}

/** What an export file holds, for choosing it before a Vault is created from it. */
export interface PackageDescription {
  path: string;
  fileName: string;
  exportedAt: string | null;
  documents: number;
  subscriptions: number;
  /** Name of the Vault folder the export came from, which a Vault created from it starts with. */
  folderName: string;
}

/** Device-side Vault location state shared by Onboarding, Settings and Agents. */
export interface VaultSetupStatus {
  state: 'ready' | 'not_ready';
  vaultPath: string | null;
  /**
   * Where a new Vault goes unless the person picks another place, and the name it starts with: the
   * folder holding the active Vault, or the Documents folder while none is active. Choosing an
   * existing Vault starts in the same folder.
   */
  newVault: { location: string; name: string };
  /** The previously selected Vault that could not be opened at startup. */
  failure: { path: string; reason: string } | null;
}

export interface VaultSetupResult {
  vault: VaultSetupStatus;
  documentCount: number;
}

export type TransferOperation = 'export' | 'import' | 'open' | 'create';

/**
 * Progress of the one Vault export, import or switch that runs at a time. `waiting` means the
 * operation waits for the collection steps already running to finish; queued collection waits until
 * the operation ends.
 */
export interface TransferStatus {
  state: 'idle' | 'waiting' | 'exporting' | 'validating' | 'extracting' | 'indexing' | 'completed' | 'error';
  operation: TransferOperation | null;
  message: string;
  completedFiles: number;
  totalFiles: number;
  vaultPath: string;
  /** What the last finished operation produced; null while one runs or after a failure. */
  result: TransferResult | null;
  /** The error code of a failed operation, such as `vault_busy`; null unless `state` is `error`. */
  errorCode: CollectorErrorCode | null;
  /** Why no other Vault can be created or opened in place of the active one; null when it can. */
  relocationUnavailable: { code: CollectorErrorCode; message: string } | null;
}

export interface TransferResult {
  /** Export: the written export file and its size. */
  exportPath?: string;
  exportBytes?: number;
  /** Export: files in the Vault folder that belong to no record of the Vault and are not in the export. */
  unregisteredFiles?: number;
  /** Import: how it was applied, the changes it made, and the export of the Vault as it was before. */
  importMode?: ImportMode;
  imported?: ChangeCounts;
  writtenFiles?: number;
  backupPath?: string;
  /** Import: the files are in place but the search index could not be updated; the person rebuilds it. */
  searchRebuildNeeded?: boolean;
  /**
   * Open: the Vault in use before the switch, which stays where it is, and how many of its
   * collection jobs stopped with the switch; they continue when that Vault is opened again.
   */
  previousVaultPath?: string;
  interruptedJobs?: number;
  /** Open: unfinished jobs of the Vault now in use that continue after the switch. */
  resumedJobs?: number;
}

/** Where an export goes when no other place is chosen: the export folder and a file name of today. */
export interface ExportSuggestion {
  folder: string;
  path: string;
}

export type ImportMode = 'merge' | 'replace';

/** Items an import adds, updates and removes, for one kind of item. */
export interface ItemCounts { added: number; updated: number; removed: number }

/** What an import changes, by kind of item. */
export interface ChangeCounts { documents: ItemCounts; subscriptions: ItemCounts }

/**
 * What importing an export file into the active Vault would change. Every document and
 * subscription carries the time of its last change, and a deletion or removal is a change of its
 * own; for each item the newer state wins, and a tie keeps the local one.
 */
export interface ImportPreview {
  id: string;
  /** The machine name is for diagnosis; the app does not show it. */
  package: { fileName: string; exportedAt: string | null; machine: string | null };
  /** What a merge changes: the items whose state in the file is newer. */
  merge: ChangeCounts;
  /** What replacing the Vault with the file's content changes; `removed` includes the items only the Vault has. */
  replace: ChangeCounts;
  /** Items that differ from the file where the Vault holds the newer state, including items only the Vault has. */
  localNewer: number;
  /**
   * A merge still writes deletion records of documents the Vault never had, which `merge` does not
   * count. Writing them keeps those items from being collected again and coming back on later imports.
   */
  mergeRecords: boolean;
}

import type { CollectorErrorCode } from '../lib/collector-error.js';

export type VaultInspection =
  | { kind: 'empty'; path: string; exists: boolean }
  | { kind: 'existing'; path: string; documentCount: number }
  | { kind: 'invalid'; path: string; reason: string };

export type VaultSetupRequest =
  | { action: 'create'; location: string; name: string }
  | { action: 'open'; path: string }
  | { action: 'import'; location: string; name: string; packagePath: string };

export interface NewVaultCheck {
  /** `<location>/<name>`; null when the location or name names no folder. */
  path: string | null;
  problem: string | null;
}

export interface PackageDescription {
  path: string;
  fileName: string;
  exportedAt: string | null;
  documents: number;
  subscriptions: number;
  folderName: string;
}

export interface VaultSetupStatus {
  state: 'ready' | 'not_ready';
  vaultPath: string | null;
  /** The folder a new Vault goes in and the name it starts with, unless the person picks others. */
  newVault: { location: string; name: string };
  failure: { path: string; reason: string } | null;
}

export interface VaultSetupResult {
  vault: VaultSetupStatus;
  documentCount: number;
}

export type TransferOperation = 'export' | 'import' | 'open' | 'create';

export interface TransferStatus {
  state: 'idle' | 'waiting' | 'exporting' | 'validating' | 'extracting' | 'indexing' | 'completed' | 'error';
  operation: TransferOperation | null;
  message: string;
  completedFiles: number;
  totalFiles: number;
  vaultPath: string;
  result: TransferResult | null;
  errorCode: CollectorErrorCode | null;
  relocationUnavailable: { code: CollectorErrorCode; message: string } | null;
}

export interface TransferResult {
  exportPath?: string;
  exportBytes?: number;
  importMode?: ImportMode;
  imported?: ChangeCounts;
  writtenFiles?: number;
  backupPath?: string;
  /** Set on an import that failed after it had put some files of the export file in place. */
  partiallyApplied?: true;
  previousVaultPath?: string;
  interruptedJobs?: number;
  resumedJobs?: number;
}

export interface ExportSuggestion {
  folder: string;
  path: string;
}

export type ImportMode = 'merge' | 'replace';

export interface ItemCounts { added: number; updated: number; removed: number }

export interface ChangeCounts { documents: ItemCounts; subscriptions: ItemCounts }

export interface ImportPreview {
  id: string;
  package: { fileName: string; exportedAt: string | null; machine: string | null };
  merge: ChangeCounts;
  replace: ChangeCounts;
  localNewer: number;
  mergeRecords: boolean;
}

export interface VaultSetup {
  status(): VaultSetupStatus;
  inspect(path: string): Promise<VaultInspection>;
  checkNew(location: unknown, name: unknown): Promise<NewVaultCheck>;
  describePackage(file: unknown): Promise<PackageDescription>;
  setup(request: VaultSetupRequest): Promise<VaultSetupResult>;
}

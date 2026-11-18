/** The vault module as other modules use it: opening, creating and moving a Vault, and the collector that writes its documents. */
export { Collector } from './collector.js';
export { deletionId } from './deleted-documents.js';
export type { StatFs } from './disk-space.js';
export { MarkdownVault } from './markdown-vault.js';
export {
  checkNewVault,
  createNewVault,
  DEFAULT_VAULT_NAME,
  describePackage,
  newVaultFolder,
  type AppFolders,
} from './new-vault.js';
export {
  VaultOperationLock,
  type OperationCompletion,
  type OperationReporter,
  type OperationTerminal,
  type UpdateLease,
  type VaultAccess,
} from './operation-lock.js';
export {
  backupFolder,
  clearImportJournal,
  exportFileName,
  exportFolder,
  isWithin,
  isWorkFolder,
  recoverImport,
} from './transfer-files.js';
export { createVaultDirectory, inspectVaultDirectory, notAVault, readVaultId } from './vault-directory.js';
export { VaultExchange } from './vault-exchange.js';
export { VaultFileWriter } from './vault-files.js';
export { finishInPlaceImports, importNewVault, type ImportFault } from './vault-import.js';
export { VaultSelection } from './vault-selection.js';

/**
 * The vault module as other modules use it: the Vaults of this device (`DeviceVaults`), a Vault's
 * files opened for its services (`openVault`), the operations on the Vault in use
 * (`VaultOperations`), the collector that writes its documents, and the default export and backup
 * folders.
 */
export type { Collector } from './collector.js';
export { DeviceVaults } from './device-vaults.js';
export { openVault, type OpenedVault } from './opened-vault.js';
export type { UpdateLease } from './operation-lock.js';
export { backupFolder, exportFileName, exportFolder } from './transfer-files.js';
export { VaultOperations } from './vault-operations.js';
export type { VaultSelection } from './vault-selection.js';

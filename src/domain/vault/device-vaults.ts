import { rm } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type {
  NewVaultCheck, PackageDescription, VaultInspection, VaultSetupRequest,
} from '../../shared/vault/vault-types.js';
import type { StatFs } from './disk-space.js';
import { checkNewVault, createNewVault, DEFAULT_VAULT_NAME, describePackage, newVaultFolder } from './new-vault.js';
import { clearImportJournal, recoverImport } from './transfer-files.js';
import { createVaultDirectory, inspectVaultDirectory, notAVault } from './vault-directory.js';
import { importNewVault } from './vault-import.js';
import { VaultSelection } from './vault-selection.js';

export interface DeviceVaultsOptions {
  profilePath: string;
  sources: SourceRegistry;
  createdBy: string;
  statfs?: StatFs;
}

export type InitialVault =
  | { kind: 'open'; root: string }
  | { kind: 'unset' }
  | { kind: 'unusable'; path: string; reason: string };

/**
 * The Vaults of this device: which one the device selection names, what a start opens, and the
 * Onboarding steps that check, create, import or open a Vault while none is in use.
 */
export class DeviceVaults {
  readonly selection: VaultSelection;
  /** Name of a new Vault folder when the person gives none. */
  readonly defaultName = DEFAULT_VAULT_NAME;
  private readonly profilePath: string;

  constructor(private readonly options: DeviceVaultsOptions) {
    this.selection = new VaultSelection(path.join(options.profilePath, 'vault-selection.json'));
    this.profilePath = path.resolve(options.profilePath);
  }

  /**
   * Settles what a stop left and finds the Vault a start opens. An import from Onboarding a stop
   * interrupted is taken back unless the selection already names its Vault. `explicitPath` replaces
   * the selection, and an empty directory there becomes a new Vault; a selected Vault that is now
   * missing or empty is never recreated.
   */
  async initial(explicitPath?: string): Promise<InitialVault> {
    const { sources, createdBy } = this.options;
    await recoverImport(this.profilePath, [await this.selection.read().catch(() => null)]);
    if (explicitPath) {
      const inspection = await inspectVaultDirectory(path.resolve(explicitPath), sources);
      if (inspection.kind === 'empty') return { kind: 'open', root: await createVaultDirectory(inspection.path, createdBy, sources) };
      if (inspection.kind === 'existing') return { kind: 'open', root: inspection.path };
      return { kind: 'unusable', path: inspection.path, reason: inspection.reason };
    }
    let selected: string | null;
    try {
      selected = await this.selection.read();
    } catch {
      return { kind: 'unusable', path: this.selection.file, reason: '這台電腦的知識庫位置設定已損壞。' };
    }
    if (!selected) return { kind: 'unset' };
    const inspection = await inspectVaultDirectory(selected, sources);
    if (inspection.kind === 'existing') return { kind: 'open', root: inspection.path };
    if (inspection.kind === 'empty') {
      return { kind: 'unusable', path: selected, reason: inspection.exists ? '先前使用的知識庫目錄已經是空的。' : '找不到先前使用的知識庫目錄。' };
    }
    return { kind: 'unusable', path: selected, reason: inspection.reason };
  }

  /** What the directory `vaultPath` holds: a Vault, nothing, or something that is not a Vault. */
  inspect(vaultPath: string): Promise<VaultInspection> {
    return inspectVaultDirectory(vaultPath, this.options.sources);
  }

  /** Checks a new Vault folder before it is created, outside `activeRoot` and the profile; see `checkNewVault`. */
  checkNew(location: unknown, name: unknown, activeRoot?: string): Promise<NewVaultCheck> {
    return checkNewVault(location, name, { vaultRoot: activeRoot, profilePath: this.profilePath });
  }

  /** What an export file holds; see `describePackage`. */
  describePackage(file: unknown): Promise<PackageDescription> {
    return describePackage(file, this.options.sources);
  }

  /**
   * Creates, imports or opens a Vault while none is in use, starts its services with `start` and
   * makes the selection name it. A new Vault, empty or imported, is the new folder `name` in
   * `location`; an import fills it from the export file `packagePath` and keeps the automatic
   * collection switch the export file holds. A Vault this call created is removed again when it
   * cannot become the one in use; an imported Vault keeps its import journal until the selection
   * names it, so a stop before that takes it back too.
   */
  async setUp<W extends { close(): Promise<void> }>(
    request: VaultSetupRequest,
    start: (root: string, pendingImport: boolean) => Promise<W>,
  ): Promise<{ workspace: W; documentCount: number }> {
    const { sources, createdBy } = this.options;
    const folders = { profilePath: this.profilePath };
    const action = request.action;
    let root: string;
    let documentCount = 0;
    if (request.action === 'create') {
      root = await createNewVault(request.location, request.name, createdBy, sources, folders);
    } else if (request.action === 'import') {
      root = await importNewVault({
        packageFile: request.packagePath, folder: await newVaultFolder(request.location, request.name, folders), profilePath: this.profilePath, createdBy, sources,
        ...(this.options.statfs ? { statfs: this.options.statfs } : {}),
      });
      documentCount = (await inspectVaultDirectory(root, sources).then((inspection) => inspection.kind === 'existing' ? inspection.documentCount : 0));
    } else {
      if (!path.isAbsolute(request.path)) throw new CollectorError('invalid_request', '請提供完整的絕對路徑。');
      const inspection = await inspectVaultDirectory(request.path, sources);
      if (inspection.kind !== 'existing') throw new CollectorError('vault_invalid', notAVault(inspection));
      root = inspection.path;
      documentCount = inspection.documentCount;
    }
    const discard = async () => {
      if (action === 'import') await recoverImport(this.profilePath, []).catch(() => undefined);
      if (action === 'create') await rm(root, { recursive: true, force: true }).catch(() => undefined);
    };
    let workspace: W;
    try {
      workspace = await start(root, action === 'import');
    } catch (error) {
      console.error('Vault services failed to start', error);
      await discard();
      throw new CollectorError('vault_invalid', '知識庫無法啟動，請確認目錄內容與搜尋服務後重試。', { cause: error });
    }
    try {
      await this.selection.write(root);
    } catch (error) {
      await workspace.close().catch(() => undefined);
      await discard();
      throw new CollectorError('vault_invalid', '無法保存知識庫位置，請確認程式資料目錄可寫入後重試。', { cause: error });
    }
    if (action === 'import') await clearImportJournal(this.profilePath);
    return { workspace, documentCount };
  }
}

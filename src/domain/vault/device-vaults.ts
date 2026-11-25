import { rm } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type {
  NewVaultCheck, PackageDescription, VaultInspection, VaultSetupRequest,
} from '../../shared/vault/vault-types.js';
import { checkNewVault, createNewVault, DEFAULT_VAULT_NAME, describePackage, newVaultFolder } from './new-vault.js';
import { createVaultDirectory, inspectVaultDirectory, notAVault } from './vault-directory.js';
import { importNewVault } from './vault-import.js';
import { VaultSelection } from './vault-selection.js';

export interface DeviceVaultsOptions {
  profilePath: string;
  sources: SourceRegistry;
  createdBy: string;
}

export type InitialVault =
  | { kind: 'open'; root: string }
  | { kind: 'unset' }
  | { kind: 'unusable'; path: string; reason: string };

export class DeviceVaults {
  readonly selection: VaultSelection;
  readonly defaultName = DEFAULT_VAULT_NAME;

  constructor(private readonly options: DeviceVaultsOptions) {
    this.selection = new VaultSelection(options.profilePath);
  }

  async initial(explicitPath?: string): Promise<InitialVault> {
    const { sources, createdBy } = this.options;
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

  inspect(vaultPath: string): Promise<VaultInspection> {
    return inspectVaultDirectory(vaultPath, this.options.sources);
  }

  checkNew(location: unknown, name: unknown, vaultInUse: string | null): Promise<NewVaultCheck> {
    return checkNewVault(location, name, { vaultRoot: vaultInUse, profilePath: this.options.profilePath });
  }

  describePackage(file: unknown): Promise<PackageDescription> {
    return describePackage(file, this.options.sources);
  }

  async setUp<W extends { close(): Promise<void> }>(
    request: VaultSetupRequest,
    start: (root: string) => Promise<W>,
  ): Promise<{ workspace: W; documentCount: number }> {
    const { sources, createdBy, profilePath } = this.options;
    const folders = { vaultRoot: null, profilePath };
    const action = request.action;
    let root: string;
    let documentCount = 0;
    if (request.action === 'create') {
      root = await createNewVault(request.location, request.name, createdBy, folders);
    } else if (request.action === 'import') {
      root = await importNewVault({
        packageFile: request.packagePath, folder: await newVaultFolder(request.location, request.name, folders), createdBy, sources,
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
      if (action !== 'open') await rm(root, { recursive: true, force: true }).catch(() => undefined);
    };
    let workspace: W;
    try {
      workspace = await start(root);
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
    return { workspace, documentCount };
  }
}

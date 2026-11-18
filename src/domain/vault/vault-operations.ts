import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { NewJobEvent } from '../../shared/activity/activity-types.js';
import type { EventType } from '../../shared/activity/event-catalog.js';
import type { NoteChange } from '../../shared/api/changes.js';
import type { TranscriptSearch } from '../../shared/api/search-types.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type {
  ExportSuggestion, ImportPreview, TransferOperation, TransferResult, TransferStatus,
} from '../../shared/vault/vault-types.js';
import type { StatFs } from './disk-space.js';
import { createNewVault, newVaultFolder } from './new-vault.js';
import type { OpenedVault } from './opened-vault.js';
import {
  VaultOperationLock, type OperationCompletion, type OperationReporter, type OperationTerminal, type UpdateLease, type VaultAccess,
} from './operation-lock.js';
import { isWithin, isWorkFolder, recoverImport } from './transfer-files.js';
import { inspectVaultDirectory, notAVault } from './vault-directory.js';
import { VaultExchange } from './vault-exchange.js';
import { finishInPlaceImports, type ImportFault } from './vault-import.js';
import type { VaultSelection } from './vault-selection.js';

/** A Vault whose services are built and started but not yet in use. */
export interface PreparedVault {
  /** Makes it the Vault in use, once the device selection names it, and returns the one it replaced. */
  activate(): ReplacedVault;
  /** Stops its services; it never became the Vault in use. */
  discard(): Promise<void>;
}

/** The Vault a switch replaced, whose services still run until `settle`. */
export interface ReplacedVault {
  readonly root: string;
  /**
   * Stops its services, recording its unfinished jobs as interrupted with `reason`, then continues
   * the unfinished jobs of the Vault now in use and starts its scheduler. Never fails: the switch
   * has already happened.
   */
  settle(reason: string): Promise<{ interruptedJobs: number; resumedJobs: number }>;
}

/** What the operations need from the workspace that builds the services of each Vault it opens. */
export interface OperationsHost {
  /** The Vault in use at the time of the call and its search. */
  current(): { vault: OpenedVault; search: TranscriptSearch };
  /** Stops collection of the Vault in use from starting steps, waits for running ones, and returns the release. */
  hold(signal: AbortSignal): Promise<() => void>;
  /** Resolves once the scheduler of the Vault in use has no check under way. */
  idle(): Promise<void>;
  /** Suspends or resumes the scheduler of the Vault in use. */
  suspend(value: boolean): void;
  /** Records an event in the device activity log. */
  event(entry: NewJobEvent): void;
  /** Restarts collection checks after an import replaced the subscriptions. */
  reloadSchedule(): Promise<void>;
  /** Builds and starts the services of the Vault at `root` and indexes it, without making it the one in use. */
  prepare(root: string): Promise<PreparedVault>;
}

export interface VaultOperationsOptions {
  /** The source types of every Vault these operations open, create, export or import. */
  sources: SourceRegistry;
  /** Device record of the active Vault; writing it is the commit point of a switch. */
  selection: VaultSelection;
  /** Device profile folder: no Vault, export or import names a file inside it. */
  profilePath: string;
  /** Folder exports go to when no other place is chosen. */
  exportFolder: string;
  /** Folder an import backs the Vault up to before it applies. */
  backupFolder: string;
  /** Application name and version written into markers and exports. */
  createdBy: string;
  /** Name of this machine in exports; defaults to `machineName()`. */
  machineName?: string;
  /** Free space of a volume; defaults to `fs.statfs`. */
  statfs?: StatFs;
  /** Called at each step of an in-place import, for tests that make a step fail or stop there; see `ImportFault`. */
  importFaults?: (phase: ImportFault, count?: number) => void | Promise<void>;
  /** The Vault location is fixed for this run, so no other Vault is created or opened. */
  fixedLocation?: boolean;
  /** Hears each change of the operation status, and of the Vault's contents once an import or switch completes. */
  noteChange: NoteChange;
}

/**
 * Every operation on the Vault in use, under one operation lock: export, import, creating a new
 * Vault and opening another, and the request leases that keep reads and writes out of their way.
 * Each runs the same lifecycle: stop dispatch, wait for collection steps under way, carry out the
 * operation, resume collection, then publish the completed or error state.
 */
export class VaultOperations {
  private readonly lock: VaultOperationLock;
  private readonly exchange: VaultExchange;

  constructor(private readonly options: VaultOperationsOptions, private readonly host: OperationsHost) {
    this.lock = new VaultOperationLock({
      hold: (signal) => host.hold(signal),
      idle: () => host.idle(),
      suspend: (value) => host.suspend(value),
      changed: () => {
        const status = this.lock.status();
        options.noteChange({ kind: 'vault', scope: 'transfer' });
        // A finished import or switch replaced what every page shows.
        if (status.state === 'completed' && status.operation !== 'export') options.noteChange({ kind: 'vault', scope: 'contents' });
      },
    });
    this.exchange = new VaultExchange({
      sources: options.sources, profilePath: options.profilePath, exportFolder: options.exportFolder, backupFolder: options.backupFolder,
      createdBy: options.createdBy,
      ...(options.machineName ? { machineName: options.machineName } : {}),
      ...(options.statfs ? { statfs: options.statfs } : {}),
      ...(options.importFaults ? { importFaults: options.importFaults } : {}),
    }, {
      current: () => {
        const { vault, search } = host.current();
        return { root: vault.root, vaultId: vault.vaultId, files: vault.files, search };
      },
      run: (operation, label, body) => this.run(operation, label, body),
      isLocked: () => this.lock.isLocked(),
      setIdle: (message) => this.lock.setIdle(message),
      record: (severity, eventType, message) => this.record(severity, eventType, message),
      reloadSchedule: () => host.reloadSchedule(),
      status: () => this.status(),
    });
  }

  /**
   * Settles what a stop interrupted before the Vault at `root` opens: takes back an import from
   * Onboarding unless the device selection or `root` is its Vault (or the import is `pending`, still
   * waiting for the selection), and finishes an in-place import interrupted after its commit point.
   * Returns whether such an import was finished, in which case the search index needs a rebuild.
   */
  async recover(root: string, pending = false): Promise<boolean> {
    const selected = await this.options.selection.read().catch(() => null);
    // The selected Vault and the one being opened are never taken back, whatever the journal says.
    if (!pending) await recoverImport(this.options.profilePath, [selected, root]);
    return finishInPlaceImports(root, this.options.sources);
  }

  status(): TransferStatus {
    const problem = this.relocationProblem();
    return {
      ...this.lock.status(), vaultPath: this.host.current().vault.root,
      relocationUnavailable: problem ? { code: problem.code, message: problem.message } : null,
    };
  }

  /** Why no other Vault can be created or opened in place of the active one; null when it can. */
  private relocationProblem(): CollectorError | null {
    if (this.options.fixedLocation) {
      return new CollectorError('vault_location_fixed', '這次啟動指定了固定的知識庫位置，無法建立或開啟其他知識庫。');
    }
    return null;
  }

  /** Takes a lease of `access` for one request, or throws when the operation under way excludes it; returns the release. */
  enter(access: VaultAccess): () => void { return this.lock.enter(access); }

  /** Excludes operations and new writes, then waits for current writes and collection to settle. */
  prepareUpdate(signal: AbortSignal): Promise<UpdateLease> { return this.lock.prepareUpdate(signal); }

  /** Resolves once the operation under way has published its final state. */
  finished(): Promise<void> { return this.lock.finished(); }

  /**
   * Cancels the operation that is still waiting for collection steps: collection continues, nothing
   * is written, and the status returns to idle. An operation past the wait runs to its end.
   */
  cancelWait(): TransferStatus {
    this.lock.cancelWait();
    return this.status();
  }

  /** See `VaultExchange.exportSuggestion`. */
  exportSuggestion(): ExportSuggestion { return this.exchange.exportSuggestion(); }

  /** See `VaultExchange.exportTo`. */
  exportTo(file?: unknown, overwrite = false): Promise<TransferStatus> { return this.exchange.exportTo(file, overwrite); }

  /** See `VaultExchange.previewImport`. */
  previewImport(file: unknown): Promise<ImportPreview> { return this.exchange.previewImport(file); }

  /** See `VaultExchange.cancelImport`. */
  cancelImport(id: string): void { this.exchange.cancelImport(id); }

  /** See `VaultExchange.applyImport`. */
  applyImport(id: string, mode: unknown): TransferStatus { return this.exchange.applyImport(id, mode); }

  /** Forgets the import comparison waiting to be applied. */
  dropPreview(): void { this.exchange.dropPreview(); }

  /**
   * Switches to another existing Vault; progress is in `status`. The active Vault stays where it is,
   * and its unfinished jobs continue when it is opened again.
   */
  async openOther(value: unknown): Promise<TransferStatus> {
    const problem = this.relocationProblem();
    if (problem) throw problem;
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
      throw new CollectorError('invalid_request', '請提供知識庫資料夾的完整路徑。');
    }
    const root = path.resolve(value);
    if (isWorkFolder(root)) {
      throw new CollectorError('invalid_request', '這是匯入使用的暫存資料夾，不能當作知識庫開啟。');
    }
    const current = this.host.current().vault.root;
    if (await isWithin(root, current)) {
      throw new CollectorError('invalid_request', await isWithin(current, root)
        ? '這就是目前使用中的知識庫。' : '不能開啟目前知識庫裡的資料夾。');
    }
    if (await isWithin(root, this.options.profilePath)) throw new CollectorError('invalid_request', '不能開啟程式資料目錄裡的資料夾。');
    const inspection = await inspectVaultDirectory(root, this.options.sources);
    if (inspection.kind !== 'existing') throw new CollectorError('vault_invalid', notAVault(inspection));
    this.exchange.dropPreview();
    void this.run('open', '開啟其他知識庫', (reporter) => this.openOnce(inspection.path, reporter)).catch(() => undefined);
    return this.status();
  }

  /**
   * Creates the new Vault folder `name` in `location` and switches to it; progress is in `status`.
   * The folder is checked before anything stops, and a switch that fails removes the new folder, so
   * the active Vault stays in use and the location stays as it was.
   */
  async createNew(location: unknown, name: unknown): Promise<TransferStatus> {
    const problem = this.relocationProblem();
    if (problem) throw problem;
    const folders = { vaultRoot: this.host.current().vault.root, profilePath: this.options.profilePath };
    await newVaultFolder(location, name, folders);
    this.exchange.dropPreview();
    void this.run('create', '建立知識庫', async (reporter) => {
      const root = await createNewVault(location, name, this.options.createdBy, this.options.sources, folders);
      try {
        return await this.openOnce(root, reporter, 'created');
      } catch (error) {
        // Once the switch committed, the new Vault is the one in use and stays.
        if (this.host.current().vault.root !== root) {
          await rm(root, { recursive: true, force: true }).catch((cleanup: unknown) => console.error('Removing the new Vault failed', cleanup));
        }
        throw error;
      }
    }).catch(() => undefined);
    return this.status();
  }

  /**
   * Makes the Vault at `root` the one in use. Writing the device selection is the commit point of
   * every switch: before it the previous Vault stays active and untouched, after it the switch is
   * never undone.
   */
  private async openOnce(root: string, reporter: OperationReporter, how: 'opened' | 'created' = 'opened'): Promise<OperationCompletion<void>> {
    let candidate: PreparedVault | null = null;
    let previous: ReplacedVault;
    try {
      reporter.progress('indexing', '正在開啟知識庫並建立搜尋索引…');
      // An import a stop interrupted after its commit point is finished before anything reads the Vault;
      // preparing the Vault then indexes the finished content.
      await finishInPlaceImports(root, this.options.sources);
      candidate = await this.host.prepare(root);
      await this.options.selection.write(root);
      previous = candidate.activate();
      reporter.discardHold();
      candidate = null;
    } catch (error) {
      if (!(error instanceof CollectorError)) console.error('Opening another Vault failed', error);
      const failure = error instanceof CollectorError ? error
        : new CollectorError('vault_invalid', `無法開啟 ${root}，請確認資料夾與搜尋服務後重試。目前的知識庫不變。`);
      if (candidate) await candidate.discard();
      throw failure;
    }
    const { interruptedJobs, resumedJobs } = await previous.settle('切換到其他知識庫時工作尚未完成；回到這個知識庫時接續。');
    const paused = interruptedJobs ? `它的 ${interruptedJobs} 個收集工作已暫停，回到原知識庫時接續。` : '';
    const resumed = resumedJobs ? `這個知識庫有 ${resumedJobs} 個收集工作接續。` : '';
    const message = `已${how === 'created' ? '建立並開啟' : '開啟'}知識庫 ${root}。原知識庫保留在 ${previous.root}。${paused}${resumed}`;
    const result: TransferResult = { previousVaultPath: previous.root, interruptedJobs, resumedJobs };
    // Device-level, so both Vaults show the switch.
    this.record('info', how === 'created' ? 'vault.created' : 'vault.opened', message, null);
    return { value: undefined, message, result };
  }

  /** Runs one operation step under the lock; the lock is released whether it succeeds or fails. */
  private run<T>(operation: TransferOperation, label: string, body: (reporter: OperationReporter) => Promise<OperationCompletion<T>>): Promise<T> {
    return this.lock.start({
      operation, body, failed: (error) => this.failure(error, label),
      cancelled: () => this.record('info', 'vault.transfer_cancelled', `已取消${label}，資料未變更。`),
    });
  }

  private failure(error: unknown, operation: string): OperationTerminal {
    const message = error instanceof CollectorError ? error.message : '操作失敗，請確認匯出檔、磁碟空間與搜尋服務後重試。';
    this.record('error', 'vault.transfer_failed', `${operation}失敗：${message}`,
      undefined, error instanceof CollectorError ? error.code : undefined);
    return { message, result: null, errorCode: error instanceof CollectorError ? error.code : null };
  }

  /** Records an operation in the device activity log, under the active Vault unless `vaultPath` says otherwise. */
  private record(severity: 'info' | 'warning' | 'error', eventType: EventType, message: string, vaultPath?: string | null, errorCode?: string): void {
    const own = vaultPath === undefined;
    const { root, vaultId } = this.host.current().vault;
    this.host.event({
      severity, eventType, message, vaultPath: own ? root : vaultPath, jobId: null,
      ...(own && vaultId ? { vaultId } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { NewJobEvent } from '../../shared/activity/activity-types.js';
import type { EventType } from '../../shared/activity/event-catalog.js';
import type { NoteChange } from '../../shared/api/changes.js';
import type { TranscriptSearch } from '../../shared/api/search-types.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type {
  ChangeCounts, ExportSuggestion, ImportMode, ImportPreview, TransferOperation, TransferResult, TransferStatus,
} from '../../shared/vault/vault-types.js';
import { documentIdFromPath } from './document-paths.js';
import { MarkdownVault } from './markdown-vault.js';
import { createNewVault, newVaultFolder } from './new-vault.js';
import type { OpenedVault } from './opened-vault.js';
import {
  VaultOperationLock, type OperationCompletion, type OperationReporter, type OperationTerminal, type UpdateLease,
} from './operation-lock.js';
import { backupFileName, checkExportFile, checkPackageFile, exportFileName, isSameFolder } from './transfer-files.js';
import { inspectVaultDirectory, notAVault } from './vault-directory.js';
import { stageImport } from './vault-import.js';
import { changeTotal, chosenKeys, compareItems, itemStates, planChanges, type Comparison, type FileSource, type ItemStates } from './vault-merge.js';
import {
  checkPackageContent, machineName, openPackage, registeredFiles, registeredSource, writePackage, type PackageReader,
} from './vault-package.js';
import type { VaultSelection } from './vault-selection.js';
import { errorCode } from './errno.js';

export interface PreparedVault {
  activate(): ReplacedVault;
  discard(): Promise<void>;
}

export interface ReplacedVault {
  readonly root: string;
  settle(reason: string): Promise<{ interruptedJobs: number; resumedJobs: number }>;
}

export interface OperationsHost {
  current(): { vault: OpenedVault; search: TranscriptSearch };
  hold(signal?: AbortSignal): Promise<() => void>;
  idle(): Promise<void>;
  suspend(value: boolean): void;
  event(entry: NewJobEvent): void;
  flushJobs(): Promise<void>;
  reloadSchedule(): Promise<void>;
  prepare(root: string): Promise<PreparedVault>;
}

export interface VaultOperationsOptions {
  sources: SourceRegistry;
  selection: VaultSelection;
  exportFolder: string;
  backupFolder: string;
  createdBy: string;
  machineName?: string;
  fixedLocation?: boolean;
  noteChange: NoteChange;
}

interface Preview { value: ImportPreview; comparison: Comparison; file: string }

class PartialImport extends Error {
  constructor(readonly mode: ImportMode, readonly backupPath: string, cause: unknown) {
    super('An import stopped while it put files in place', { cause });
  }
}

/**
 * Every operation on the Vault in use, under one operation lock: export, import, creating a new
 * Vault and opening another, one at a time, with writes refused while one runs. Each runs the same
 * lifecycle: stop dispatch, wait for collection steps under way, carry out the operation, resume
 * collection, then publish the completed or error state.
 *
 * An export writes the Vault into an export file. An import compares an export file with the Vault
 * and keeps the comparison until it is applied in place, after the Vault is backed up. Applying
 * first extracts every incoming file into a staging folder in the Vault, then puts each in place;
 * an import that fails while it puts files in place ends in `error` with `result.partiallyApplied`
 * and the backup in `result.backupPath`.
 */
export class VaultOperations {
  private readonly lock: VaultOperationLock;
  private readonly machine: string;
  private preview: Preview | null = null;

  constructor(private readonly options: VaultOperationsOptions, private readonly host: OperationsHost) {
    this.machine = options.machineName ?? machineName();
    this.lock = new VaultOperationLock({
      hold: (signal) => host.hold(signal),
      idle: () => host.idle(),
      suspend: (value) => host.suspend(value),
      changed: () => {
        const status = this.lock.status();
        options.noteChange({ kind: 'vault', scope: 'transfer' });
        const changedContents = status.state === 'completed' ? status.operation !== 'export' : status.result?.partiallyApplied === true;
        if (changedContents) options.noteChange({ kind: 'vault', scope: 'contents' });
      },
    });
  }

  status(): TransferStatus {
    const problem = this.relocationProblem();
    return {
      ...this.lock.status(), vaultPath: this.host.current().vault.root,
      relocationUnavailable: problem ? { code: problem.code, message: problem.message } : null,
    };
  }

  private relocationProblem(): CollectorError | null {
    if (this.options.fixedLocation) {
      return new CollectorError('vault_location_fixed', '這次啟動指定了固定的知識庫位置，無法建立或開啟其他知識庫。');
    }
    return null;
  }

  /** Takes a write lease for one request, or throws while an operation runs; returns the release. */
  enterWrite(): () => void { return this.lock.enterWrite(); }

  /** Excludes operations and new writes, then waits for current writes and collection to settle. */
  prepareUpdate(signal: AbortSignal): Promise<UpdateLease> { return this.lock.prepareUpdate(signal); }

  /** Resolves once the operation under way has published its final state and the job records it changed are written. */
  async finished(): Promise<void> {
    await this.lock.finished();
    await this.host.flushJobs();
  }

  /** Where an export goes when no other place is chosen: the export folder and a file name of today. */
  exportSuggestion(): ExportSuggestion {
    const folder = this.options.exportFolder;
    return { folder, path: path.join(folder, exportFileName(new Date())) };
  }

  /**
   * Writes the export of the active Vault to `file`, or to the suggested file in the export folder
   * when `file` is left out; an existing file is replaced only with `overwrite`. A missing export
   * folder is created for a file inside it, such as the suggested file the export dialog fills in;
   * any other folder must exist, so a mistyped path is reported instead of creating a folder. The
   * export only reads the Vault.
   */
  async exportTo(file?: unknown, overwrite = false): Promise<TransferStatus> {
    const requested = file ?? this.exportSuggestion().path;
    const intoExportFolder = typeof requested === 'string' && path.isAbsolute(requested)
      && path.dirname(path.resolve(requested)) === path.resolve(this.options.exportFolder);
    if (intoExportFolder) {
      await mkdir(this.options.exportFolder, { recursive: true });
    }
    const target = await checkExportFile(requested, overwrite);
    await this.run('export', '匯出', async (reporter) => {
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await this.pack(temporary, new Date(), reporter);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      const result: TransferResult = { exportPath: target, exportBytes: (await stat(target)).size };
      this.record('info', 'vault.exported', `已匯出知識庫：${target}`);
      return { value: undefined, message: `已匯出：${target}`, result };
    });
    return this.status();
  }

  private async pack(file: string, exportedAt: Date, reporter: OperationReporter): Promise<void> {
    reporter.progress('exporting', '正在匯出…');
    const { vault } = this.host.current();
    return writePackage(vault.root, this.options.sources, file, {
      createdBy: this.options.createdBy, exportedAt, source: { vaultId: vault.vaultId, machine: this.machine, folderName: path.basename(vault.root) },
    });
  }

  /**
   * Compares an export file with the active Vault and keeps the comparison for `applyImport`. The
   * file stays where it is; the comparison is dropped when another Vault operation starts.
   */
  async previewImport(file: unknown): Promise<ImportPreview> {
    const source = await checkPackageFile(file);
    return this.run('import', '匯入', async (reporter) => {
      this.dropPreview();
      reporter.progress('validating', '正在檢查匯出檔…');
      const reader = await openPackage(source, this.options.sources);
      try {
        await checkPackageContent(reader, this.options.sources);
        reporter.progress('validating', '正在比對…');
        const { comparison } = await this.compare(reader);
        const { exportedAt, source: from } = reader.manifest;
        const value: ImportPreview = {
          id: randomUUID(),
          package: { fileName: path.basename(source), exportedAt: exportedAt ?? null, machine: from?.machine ?? null },
          merge: comparison.merge, replace: comparison.replace, localNewer: comparison.localNewer,
          mergeRecords: comparison.mergeKeys.length > 0 && !changeTotal(comparison.merge),
        };
        this.preview = { value, comparison, file: source };
        return { value, message: '比對完成。', result: null };
      } finally {
        reader.close();
      }
    });
  }

  private async compare(reader: PackageReader): Promise<{ comparison: Comparison; local: FileSource; localStates: ItemStates }> {
    const sources = this.options.sources;
    const local = registeredSource(await registeredFiles(this.host.current().vault.root, sources));
    const localStates = await itemStates(sources, local);
    return { comparison: compareItems(localStates, await itemStates(sources, reader)), local, localStates };
  }

  /** Forgets the import comparison waiting to be applied. */
  dropPreview(): void {
    this.preview = null;
  }

  cancelImport(id: string): void {
    if (this.lock.isLocked()) throw new CollectorError('vault_busy', '正在套用匯入，請等待結果。');
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    this.dropPreview();
    this.lock.setIdle('已取消匯入，資料未變更。');
  }

  /**
   * Applies a compared import in place: a merge takes every item whose state in the file is newer,
   * a replace makes every item what the file holds, both as the Vault and the file are when the
   * import runs. Progress is in `status`.
   */
  applyImport(id: string, mode: unknown): TransferStatus {
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    if (mode !== 'merge' && mode !== 'replace') throw new CollectorError('invalid_request', 'mode 必須是 merge 或 replace。');
    const preview = this.preview;
    if (mode === 'merge' && !preview.comparison.mergeKeys.length) throw new CollectorError('invalid_request', '沒有需要匯入的內容。');
    if (mode === 'replace' && !preview.comparison.replaceKeys.length) throw new CollectorError('invalid_request', '本機內容已與匯入檔相同。');
    void this.run('import', '匯入', (reporter) => this.importOnce(preview, mode, reporter)).catch(() => undefined);
    this.dropPreview();
    return this.status();
  }

  private async backUp(reporter: OperationReporter): Promise<string> {
    const folder = this.options.backupFolder;
    await mkdir(folder, { recursive: true });
    const now = new Date();
    const name = backupFileName(now);
    let target = path.join(folder, name);
    for (let index = 2; await exists(target); index += 1) target = path.join(folder, name.replace(/\.zip$/u, ` (${index}).zip`));
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await this.pack(temporary, now, reporter);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return target;
  }

  private async importOnce(preview: Preview, mode: ImportMode, reporter: OperationReporter): Promise<OperationCompletion<void>> {
    const root = this.host.current().vault.root;
    reporter.progress('validating', '正在檢查本機資料…');
    const reader = await openPackage(preview.file, this.options.sources);
    try {
      const { comparison, local, localStates } = await this.compare(reader);
      const plan = await planChanges(this.options.sources, local, reader, chosenKeys(comparison, mode), localStates);
      const counts = mode === 'replace' ? comparison.replace : comparison.merge;
      reporter.progress('exporting', '正在匯出目前的內容…');
      const backup = await this.backUp(reporter);
      reporter.progress('extracting', '正在套用匯入的內容…', { completed: 0, total: plan.changes.size });
      const staged = await stageImport(root, this.options.sources, reader, plan.changes);
      try {
        await staged.place((done, total) => reporter.files(done, total));
      } catch (error) {
        await this.host.reloadSchedule().catch((again: unknown) => console.error('Reloading the schedule after a partial import failed', again));
        throw new PartialImport(mode, backup, error);
      }
      reporter.progress('indexing', '正在更新搜尋索引…');
      try {
        await this.indexChanged(plan.changes);
      } catch (error) {
        console.error('Updating the search index after an import failed', error);
      }
      try {
        await this.host.reloadSchedule();
      } catch (error) {
        console.error('Reloading the schedule after an import failed', error);
      }
      const summary = changeSummary(counts);
      const how = mode === 'replace' ? '已完全以匯入內容取代' : '匯入完成';
      const { fileName, machine } = preview.value.package;
      const file = machine ? `${fileName}，來自 ${machine}` : fileName;
      this.record('info', 'vault.imported', `${how}（${file}）：${summary}。匯入前的內容已備份到 ${backup}`);
      return {
        value: undefined, message: `${how}：${summary}。匯入前的內容已備份到 ${backup}`,
        result: { importMode: mode, imported: counts, writtenFiles: plan.changes.size, backupPath: backup },
      };
    } finally {
      reader.close();
    }
  }

  private async indexChanged(changes: ReadonlyMap<string, unknown>): Promise<void> {
    const { vault: opened, search } = this.host.current();
    const vault = new MarkdownVault(opened.files);
    for (const relative of changes.keys()) {
      const id = documentIdFromPath(this.options.sources, relative);
      if (!id) continue;
      const document = await vault.read(id).catch(() => null);
      if (document) await search.index(document);
      else await search.remove(id);
    }
  }

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
    if (await isSameFolder(root, this.host.current().vault.root)) throw new CollectorError('invalid_request', '這就是目前使用中的知識庫。');
    const inspection = await inspectVaultDirectory(root, this.options.sources);
    if (inspection.kind !== 'existing') throw new CollectorError('vault_invalid', notAVault(inspection));
    this.dropPreview();
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
    await newVaultFolder(location, name);
    this.dropPreview();
    void this.run('create', '建立知識庫', async (reporter) => {
      const root = await createNewVault(location, name, this.options.createdBy);
      try {
        return await this.openOnce(root, reporter, 'created');
      } catch (error) {
        if (this.host.current().vault.root !== root) {
          await rm(root, { recursive: true, force: true }).catch((cleanup: unknown) => console.error('Removing the new Vault failed', cleanup));
        }
        throw error;
      }
    }).catch(() => undefined);
    return this.status();
  }

  private async openOnce(root: string, reporter: OperationReporter, how: 'opened' | 'created' = 'opened'): Promise<OperationCompletion<void>> {
    let candidate: PreparedVault | null = null;
    let previous: ReplacedVault;
    try {
      reporter.progress('indexing', '正在開啟知識庫並建立搜尋索引…');
      candidate = await this.host.prepare(root);
      await this.options.selection.write(root);
      previous = candidate.activate();
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
    this.record('info', how === 'created' ? 'vault.created' : 'vault.opened', message, null);
    return { value: undefined, message, result };
  }

  private run<T>(operation: TransferOperation, label: string, body: (reporter: OperationReporter) => Promise<OperationCompletion<T>>): Promise<T> {
    return this.lock.start({ operation, body, failed: (error) => this.failure(error, label) });
  }

  private failure(error: unknown, operation: string): OperationTerminal {
    const partial = error instanceof PartialImport ? error : null;
    const problem = partial ? partial.cause : error;
    const reason = problem instanceof CollectorError ? problem.message : '操作失敗，請確認匯出檔、磁碟空間與搜尋服務後重試。';
    const errorCode = problem instanceof CollectorError ? problem.code : null;
    const message = partial
      ? `匯入未完成，部分內容已更新：${reason}用匯入前的備份 ${partial.backupPath} 以「完全取代」匯入即可還原。`
      : reason;
    this.record('error', 'vault.transfer_failed', partial ? message : `${operation}失敗：${message}`, undefined, errorCode ?? undefined);
    const result: TransferResult | null = partial ? { importMode: partial.mode, backupPath: partial.backupPath, partiallyApplied: true } : null;
    return { message, result, errorCode };
  }

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

function changeSummary(counts: ChangeCounts): string {
  const part = (label: string, kind: ChangeCounts['documents']) => {
    const items = [['新增', kind.added], ['更新', kind.updated], ['刪除', kind.removed]].filter(([, count]) => count)
      .map(([verb, count]) => `${verb} ${count}`);
    return items.length ? `${label}：${items.join('、')}` : null;
  };
  return [part('文件', counts.documents), part('訂閱', counts.subscriptions)].filter(Boolean).join('；') || '沒有變更';
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

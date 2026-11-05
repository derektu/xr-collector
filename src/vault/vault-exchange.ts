import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../core/canonical-json.js';
import { CollectorError } from '../core/collector-error.js';
import type { EventType } from '../core/event-catalog.js';
import type { TranscriptSearch } from '../core/search-types.js';
import type { SourceRegistry } from '../core/source-registry.js';
import type {
  ChangeCounts,
  ExportSuggestion,
  ImportMode,
  ImportPreview,
  TransferOperation,
  TransferResult,
  TransferStatus,
} from '../core/vault-types.js';
import { documentIdFromPath } from './document-paths.js';
import type { StatFs } from './disk-space.js';
import { MarkdownVault } from './markdown-vault.js';
import type { OperationCompletion, OperationReporter } from './operation-lock.js';
import { backupFileName, checkExportFile, checkPackageFile, exportFileName } from './transfer-files.js';
import type { VaultFileWriter } from './vault-files.js';
import { applyInPlace, checkFreeSpace, finishInPlaceImports, type ImportFault } from './vault-import.js';
import { changeTotal, chosenKeys, compareItems, itemStates, planChanges, type Comparison, type ImportPlan, type ItemStates } from './vault-merge.js';
import {
  checkPackageContent, machineName, openPackage, registeredFiles, registeredSource, writePackage, type PackageReader, type WrittenPackage,
} from './vault-package.js';

/** The Vault in use, as an export or an import reads and writes it. */
export interface ExchangeVault {
  readonly root: string;
  /** ID from the Vault's marker. */
  readonly vaultId: string;
  /** The way every write reaches the Vault's files. */
  readonly files: VaultFileWriter;
  readonly search: TranscriptSearch;
}

/** What an exchange needs from the workspace that holds the Vault in use. */
export interface ExchangeHost {
  /** The Vault in use at the time of the call. */
  current(): ExchangeVault;
  /** Runs one step under the Vault operation lock; the lock is released whether it succeeds or fails. */
  run<T>(operation: TransferOperation, label: string, body: (reporter: OperationReporter) => Promise<OperationCompletion<T>>): Promise<T>;
  /** Whether a Vault operation holds the lock. */
  isLocked(): boolean;
  /** Returns the operation status to idle with `message`. */
  setIdle(message: string): void;
  /** Records an operation in the device activity log under the Vault in use. */
  record(severity: 'info' | 'warning' | 'error', eventType: EventType, message: string): void;
  /** Restarts collection checks after an import replaced the subscriptions. */
  reloadSchedule(): Promise<void>;
  /** The workspace's operation status, which a started export or import answers with. */
  status(): TransferStatus;
}

export interface ExchangeOptions {
  /** The source types whose documents and subscriptions an export holds. */
  sources: SourceRegistry;
  /** Device profile folder; an export or import never names a file inside it. */
  profilePath: string;
  /** Folder exports go to when no other place is chosen. */
  exportFolder: string;
  /** Folder an import backs the Vault up to before it applies. */
  backupFolder: string;
  /** Application name and version written into exports. */
  createdBy: string;
  /** Name of this machine in exports; defaults to `machineName()`. */
  machineName?: string;
  /** Free space of a volume; defaults to `fs.statfs`. */
  statfs?: StatFs;
  /** Called at each step of an in-place import, for tests that make a step fail or stop there; see `ImportFault`. */
  importFaults?: (phase: ImportFault, count?: number) => void | Promise<void>;
}

/**
 * An import comparison waiting to be applied: the export file it compared, what it found, and a
 * digest of the local items and the file it stands on.
 */
interface Preview { value: ImportPreview; comparison: Comparison; baseline: string; file: string; identity: string }

/** An import whose journal may be written: what it changes and what it reports once its files are in place. */
interface AppliedImport {
  preview: Preview;
  mode: ImportMode;
  counts: ChangeCounts;
  plan: ImportPlan;
  backup: string;
}

/**
 * Export and import of the Vault in use: writing an export file, comparing an export file with the
 * Vault, and applying the comparison in place after backing the Vault up. Each runs under the
 * workspace's operation lock.
 */
export class VaultExchange {
  private preview: Preview | null = null;
  private readonly machine: string;

  constructor(private readonly options: ExchangeOptions, private readonly host: ExchangeHost) {
    this.machine = options.machineName ?? machineName();
  }

  private get folders() {
    return { vaultRoot: this.host.current().root, profilePath: this.options.profilePath };
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
    const target = await checkExportFile(requested, overwrite, this.folders);
    await this.host.run('export', '匯出', async (reporter) => {
      // Written beside the target and renamed, so the named file is either a whole export or untouched.
      const temporary = `${target}.${randomUUID()}.tmp`;
      let written: WrittenPackage;
      try {
        written = await this.pack(temporary, new Date(), reporter);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      const result: TransferResult = { exportPath: target, exportBytes: (await stat(target)).size, unregisteredFiles: written.unregisteredFiles };
      const others = result.unregisteredFiles ? `知識庫資料夾中有 ${result.unregisteredFiles} 個不屬於知識庫的檔案沒有包含。` : '';
      this.host.record('info', 'vault.exported', `已匯出知識庫：${target}${others}`);
      return { value: undefined, message: `已匯出：${target}${others}`, result };
    });
    return this.host.status();
  }

  private async pack(file: string, exportedAt: Date, reporter: OperationReporter): Promise<WrittenPackage> {
    reporter.progress('exporting', '正在匯出…');
    const vault = this.host.current();
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
    return this.host.run('import', '匯入', async (reporter) => {
      // A comparison refused for a busy Vault leaves the previous one usable.
      this.dropPreview();
      reporter.progress('validating', '正在檢查匯出檔…');
      const reader = await openPackage(source, this.options.sources);
      try {
        await checkPackageContent(reader, this.options.sources);
        reporter.progress('validating', '正在比對…');
        const { comparison, baseline } = await this.compare(reader);
        const { exportedAt, source: from } = reader.manifest;
        const value: ImportPreview = {
          id: randomUUID(),
          package: { fileName: path.basename(source), exportedAt: exportedAt ?? null, machine: from?.machine ?? null },
          merge: comparison.merge, replace: comparison.replace, localNewer: comparison.localNewer,
          mergeRecords: comparison.mergeKeys.length > 0 && !changeTotal(comparison.merge),
        };
        this.preview = { value, comparison, baseline, file: source, identity: reader.identity };
        return { value, message: '比對完成。', result: null };
      } finally {
        reader.close();
      }
    });
  }

  /**
   * Compares the local items with the file's items. The baseline digest covers what an apply stands
   * on: the local items and the file. Collection progress and check times are no items, so a check
   * the scheduler runs after a preview leaves the baseline as it was.
   */
  private async compare(reader: PackageReader): Promise<{ comparison: Comparison; baseline: string; local: ItemStates; incoming: ItemStates }> {
    const sources = this.options.sources;
    const local = await itemStates(sources, registeredSource(await registeredFiles(this.host.current().root, sources)));
    const incoming = await itemStates(sources, reader);
    const comparison = compareItems(local, incoming);
    const baseline = createHash('sha256').update(canonicalJson([[...local], reader.identity])).digest('hex');
    return { comparison, baseline, local, incoming };
  }

  /** Forgets the comparison waiting to be applied. */
  dropPreview(): void {
    this.preview = null;
  }

  cancelImport(id: string): void {
    if (this.host.isLocked()) throw new CollectorError('vault_busy', '正在套用匯入，請等待結果。');
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    this.dropPreview();
    this.host.setIdle('已取消匯入，資料未變更。');
  }

  /**
   * Applies a compared import in place: a merge takes every item whose state in the file is newer,
   * a replace makes every item what the file holds. Progress is in `status`.
   */
  applyImport(id: string, mode: unknown): TransferStatus {
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇匯入檔。');
    if (mode !== 'merge' && mode !== 'replace') throw new CollectorError('invalid_request', 'mode 必須是 merge 或 replace。');
    const preview = this.preview;
    if (mode === 'merge' && !preview.comparison.mergeKeys.length) throw new CollectorError('invalid_request', '沒有需要匯入的內容。');
    if (mode === 'replace' && !preview.comparison.replaceKeys.length) throw new CollectorError('invalid_request', '本機內容已與匯入檔相同。');
    void this.host.run('import', '匯入', (reporter) => this.importOnce(preview, mode, reporter)).catch(() => undefined);
    return this.host.status();
  }

  /**
   * Exports the Vault as it is into the backup folder before an import changes it, so a wrong
   * import can be undone by importing this file.
   */
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
    const root = this.host.current().root;
    let reader: PackageReader | null = null;
    let applied: AppliedImport | null = null;
    try {
      reporter.progress('validating', '正在檢查本機資料…');
      reader = await openPackage(preview.file, this.options.sources);
      const current = reader.identity === preview.identity ? await this.compare(reader) : null;
      if (!current || current.baseline !== preview.baseline) {
        this.dropPreview();
        throw new CollectorError('invalid_request', '本機資料或匯入檔在比對後有變更，請重新選擇匯入檔。');
      }
      const plan = await planChanges(this.options.sources, registeredSource(await registeredFiles(root, this.options.sources)), reader, chosenKeys(current.comparison, mode), current.local);
      const counts = mode === 'replace' ? current.comparison.replace : current.comparison.merge;
      reporter.progress('exporting', '正在匯出目前的內容…');
      const backup = await this.backUp(reporter);
      const incomingBytes = [...plan.changes.values()].reduce((sum, change) => sum + (!change ? 0
        : 'bytes' in change ? change.bytes.length : reader!.manifest.files.find((row) => row.path === change.incoming)?.size ?? 0), 0);
      await checkFreeSpace(root, incomingBytes, this.options.statfs);
      reporter.blockReads();
      applied = { preview, mode, counts, plan, backup };
      reporter.progress('extracting', '正在套用匯入的內容…', { completed: 0, total: plan.changes.size });
      await applyInPlace(root, this.options.sources, reader, plan.changes, (done, total) => {
        reporter.files(done, total);
      }, this.options.importFaults);
      return await this.importApplied(applied, mode === 'replace', reporter);
    } catch (error) {
      if (!applied) throw error;
      // Past the journal, the import is carried out to its end; before it, the Vault was never touched.
      let finished: boolean;
      try {
        finished = await finishInPlaceImports(root, this.options.sources);
      } catch (again) {
        console.error('Finishing an interrupted import failed', again);
        reporter.stop(new CollectorError('vault_busy', '匯入未完成，已停止寫入與排程。請重新啟動程式以完成匯入。'));
      }
      if (!finished) throw error;
      console.error('An import failed while it put files in place and was carried out to its end', error);
      return await this.importApplied(applied, true, reporter);
    } finally {
      reader?.close();
    }
  }

  /**
   * Completes an import whose files are in place: updates the search index (rebuilding it when
   * `rebuild` is set or an update fails), reloads the schedule and reports the import as done. An
   * index that cannot be rebuilt either leaves the import done, with the rebuild left to the person.
   */
  private async importApplied(applied: AppliedImport, rebuild: boolean, reporter: OperationReporter): Promise<OperationCompletion<void>> {
    reporter.progress('indexing', '正在更新搜尋索引…');
    let indexed = true;
    try {
      if (rebuild) await this.host.current().search.rebuild();
      else await this.indexChanged(applied.plan.changes);
      await this.host.reloadSchedule();
    } catch (error) {
      console.error('Updating the search index after an import failed; rebuilding it', error);
      try {
        await this.host.current().search.rebuild();
        await this.host.reloadSchedule();
      } catch (again) {
        console.error('Rebuilding the search index after an import failed', again);
        indexed = false;
      }
    }
    this.dropPreview();
    const { counts, mode, backup, plan } = applied;
    const summary = changeSummary(counts);
    const how = mode === 'replace' ? '已完全以匯入內容取代' : '匯入完成';
    const done = indexed ? `${how}：${summary}。` : `匯入已完成，搜尋索引需要重建：請到設定按「重建索引」，或重新啟動程式。${summary}。`;
    const message = `${done}匯入前的內容已備份到 ${backup}`;
    const result: TransferResult = {
      importMode: mode, imported: counts, writtenFiles: plan.changes.size, backupPath: backup, ...(indexed ? {} : { searchRebuildNeeded: true }),
    };
    const { fileName, machine } = applied.preview.value.package;
    const file = machine ? `${fileName}，來自 ${machine}` : fileName;
    this.host.record(indexed ? 'info' : 'warning', 'vault.imported', indexed
      ? `${how}（${file}）：${summary}。匯入前的內容已備份到 ${backup}`
      : `匯入已完成（${file}）：${summary}。搜尋索引需要重建：請到設定按「重建索引」，或重新啟動程式。匯入前的內容已備份到 ${backup}`);
    return { value: undefined, message, result };
  }

  /** Brings the search index up to date with the documents an import wrote or removed. */
  private async indexChanged(changes: ReadonlyMap<string, unknown>): Promise<void> {
    const current = this.host.current();
    const vault = new MarkdownVault(current.files);
    for (const relative of changes.keys()) {
      const id = documentIdFromPath(this.options.sources, relative);
      if (!id) continue;
      const document = await vault.read(id).catch(() => null);
      if (document) await current.search.index(document);
      else await current.search.remove(id);
    }
  }
}

/** "文件：新增 2、更新 1、刪除 1；訂閱：新增 1", for the activity log; "沒有變更" when nothing changes. */
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

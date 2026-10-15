import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Collector, type YouTubeCapture } from '../core/collector.js';
import { CollectorError, type MergePreview, type MergeChoice, type TransferStatus, type TranscriptSearch } from '../core/types.js';
import { ChannelCollector, type YouTubeChannelSource } from '../channels/channel-collector.js';
import { ChannelScheduler } from '../channels/channel-scheduler.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../channels/json-channel-schedule-store.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { MarkdownVault } from './markdown-vault.js';
import { compareFiles, fingerprint, packageFiles, mergeFiles } from './vault-merge.js';
import { exportVault, unpackVault, safePath } from './vault-package.js';
import { writeVaultMarker } from './vault-directory.js';
import type { VaultSelection } from './vault-selection.js';

interface Bundle {
  root: string;
  collector: Collector;
  channels: ChannelCollector;
  schedule: ChannelScheduler;
  runtime: SearchRuntime;
}
export interface WorkspaceOptions {
  /** Absolute path of a Vault that the caller has already inspected. */
  root: string;
  /** Device record updated when a restore switches the active Vault. */
  selection: VaultSelection;
  /** Application name and version written into markers of Vaults it creates. */
  createdBy: string;
  capture: YouTubeCapture;
  channelSource: YouTubeChannelSource;
  searchBinary: string;
  searchData: string;
  searchPort?: number;
  createSearch?: (root: string) => Promise<SearchRuntime>;
}

/** Service references stay stable for both UI and Agent while the active vault changes. */
export function forwarding<T extends object>(target: () => T): T {
  return new Proxy({} as T, {
    get(_object, key) {
      const object = target();
      const value: unknown = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export class VaultWorkspace {
  private current!: Bundle;
  private preview: { value: MergePreview; baseline: string; incoming: Buffer } | null = null;
  private locked = false;
  private mergeWriting = false;
  private requests = 0;
  private operation: Promise<void> | null = null;
  private statusValue: Omit<TransferStatus, 'vaultPath'> = {
    state: 'idle', message: '', completedFiles: 0, totalFiles: 0,
  };
  readonly collector = forwarding(() => this.current.collector);
  readonly channels = forwarding(() => this.current.channels);
  readonly schedule = forwarding(() => this.current.schedule);
  readonly search = forwarding<TranscriptSearch>(() => this.current.runtime.search);
  private readonly restoreParent: string;

  private constructor(private readonly options: WorkspaceOptions) {
    this.restoreParent = `${options.root}.restored`;
  }

  static async open(options: WorkspaceOptions): Promise<VaultWorkspace> {
    const workspace = new VaultWorkspace(options);
    const root = options.root;
    const recovered = await workspace.recoverMerge(root);
    workspace.current = await workspace.makeBundle(root, options.searchPort);
    if (recovered) {
      try { await workspace.current.runtime.search.rebuild(); await rm(`${root}.merge-journal.json`); }
      catch (error) { await workspace.current.runtime.close(); throw error; }
    }
    try {
      await workspace.current.schedule.start();
    } catch (error) {
      await workspace.current.runtime.close().catch(() => undefined);
      throw error;
    }
    return workspace;
  }

  status(): TransferStatus { return { ...this.statusValue, vaultPath: this.current.root }; }

  assertReadable(): void {
    if (this.mergeWriting) throw new CollectorError('vault_busy', '正在合併或復原資料，請稍後再讀取。');
  }

  /** Acquired by HTTP writes before any handler can yield. */
  enterWrite(): () => void {
    if (this.locked) throw new CollectorError('vault_busy', '資料搬移進行中，請稍後再操作。');
    this.requests += 1;
    let released = false;
    return () => { if (!released) { released = true; this.requests -= 1; } };
  }

  private begin(state: 'exporting' | 'validating'): void {
    if (this.locked || this.requests || this.current.collector.isBusy()
      || this.current.channels.isBusy() || this.current.schedule.isBusy()) {
      throw new CollectorError('vault_busy', '請等待目前的收集或設定操作完成，再匯出或還原。');
    }
    this.locked = true;
    this.current.schedule.setSuspended(true);
    this.statusValue = { state, message: state === 'exporting' ? '正在建立資料包…' : '正在檢查資料包…', completedFiles: 0, totalFiles: 0 };
  }

  async export(): Promise<Buffer> {
    this.begin('exporting');
    try {
      const buffer = await exportVault(this.current.root);
      this.statusValue = { ...this.statusValue, state: 'completed', message: '資料包已建立。' };
      return buffer;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.locked = false;
      this.current.schedule.setSuspended(false);
    }
  }

  restore(buffer: Buffer): TransferStatus {
    this.begin('validating');
    this.preview = null;
    this.operation = this.restoreOnce(buffer).catch((error: unknown) => this.fail(error)).finally(() => { this.operation = null; });
    return this.status();
  }

  private async restoreOnce(buffer: Buffer): Promise<void> {
    let destination: string | null = null;
    let candidate: Bundle | null = null;
    try {
      await mkdir(this.restoreParent, { recursive: true, mode: 0o700 });
      destination = await mkdtemp(path.join(this.restoreParent, 'vault-'));
      await unpackVault(buffer, destination, (done, total) => {
        this.statusValue = { state: 'extracting', message: '正在還原檔案…', completedFiles: done, totalFiles: total };
      });
      await writeVaultMarker(destination, this.options.createdBy);
      this.statusValue = { ...this.statusValue, state: 'indexing', message: '正在重建新 vault 的搜尋索引…' };
      candidate = await this.makeBundle(destination);
      // The candidate owns a separate search database; failed preparation leaves the active vault intact.
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
      await this.options.selection.write(destination);
      const previous = this.current;
      this.current = candidate;
      candidate = null;
      destination = null;
      await this.current.schedule.start();
      await previous.schedule.close();
      await previous.runtime.close().catch((error: unknown) => console.error('Previous search shutdown failed', error));
      this.statusValue = { ...this.statusValue, state: 'completed', message: '已切換到還原的獨立 vault。排程已暫停。' };
    } catch (error) {
      this.fail(error);
    } finally {
      try {
        if (candidate) {
          await candidate.schedule.close();
          await candidate.runtime.close();
        }
        if (destination) {
          await rm(destination, { recursive: true, force: true });
          await rm(this.searchPath(destination), { recursive: true, force: true });
        }
      } finally {
        this.locked = false;
        this.current.schedule.setSuspended(false);
      }
    }
  }

  async previewMerge(buffer: Buffer): Promise<MergePreview> {
    this.begin('validating');
    this.preview = null;
    let directory: string | null = null;
    try {
      await mkdir(this.restoreParent, { recursive: true });
      directory = await mkdtemp(path.join(this.restoreParent, 'preview-'));
      await unpackVault(buffer, directory, () => undefined, false);
      const local = await exportVault(this.current.root);
      const value = { id: randomUUID(), items: compareFiles(packageFiles(local), packageFiles(buffer)) };
      this.preview = { value, baseline: fingerprint(local), incoming: buffer };
      this.statusValue = { ...this.statusValue, state: 'completed', message: '比對完成，請選擇差異的處理方式。' };
      return value;
    } catch (error) { this.fail(error); throw error; }
    finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { this.locked = false; this.current.schedule.setSuspended(false); }
    }
  }

  cancelMerge(id: string): void {
    if (this.locked) throw new CollectorError('vault_busy', '正在套用合併，請等待結果。');
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新選擇資料包。');
    this.preview = null;
    this.statusValue = { ...this.statusValue, state: 'idle', message: '已取消合併，資料未變更。' };
  }

  applyMerge(id: string, choices: Record<string, MergeChoice>): TransferStatus {
    if (!this.preview || this.preview.value.id !== id) throw new CollectorError('invalid_request', '比對已失效，請重新比對。');
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new CollectorError('invalid_request', '合併選擇格式無效。');
    const preview = this.preview;
    this.begin('validating');
    this.operation = this.mergeOnce(preview, choices).catch((error: unknown) => this.fail(error)).finally(() => { this.operation = null; });
    return this.status();
  }

  private async atomicFile(file: string, bytes: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }

  private async recoverMerge(root: string): Promise<boolean> {
    const journal = `${root}.merge-journal.json`;
    let data: { backup: string; paths: string[] };
    try { data = JSON.parse(await readFile(journal, 'utf8')) as typeof data; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!data || typeof data.backup !== 'string' || !Array.isArray(data.paths)
      || !data.paths.every((entry) => typeof entry === 'string' && safePath(entry))) {
      throw new Error('Invalid merge recovery journal');
    }
    const backup = await readFile(data.backup);
    await mkdir(this.restoreParent, { recursive: true });
    const validation = await mkdtemp(path.join(this.restoreParent, 'recovery-'));
    try { await unpackVault(backup, validation, () => undefined, false); }
    finally { await rm(validation, { recursive: true, force: true }); }
    const files = packageFiles(backup);
    for (const relative of data.paths) {
      const target = path.join(root, relative);
      let entries: string[];
      try { entries = await readdir(path.dirname(target)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries = []; }
      for (const name of entries) {
        const prefix = `${path.basename(target)}.`;
        if (name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/u.test(name.slice(prefix.length))) {
          await rm(path.join(path.dirname(target), name), { force: true });
        }
      }
      const original = files.get(relative);
      if (original) await this.atomicFile(path.join(root, relative), original);
      else await rm(path.join(root, relative), { force: true });
    }
    // Keep the journal until the caller has also repaired the search projection.
    return true;
  }

  private async mergeOnce(preview: NonNullable<VaultWorkspace['preview']>, choices: Record<string, MergeChoice>): Promise<void> {
    const root = this.current.root;
    const journal = `${root}.merge-journal.json`;
    let journalWritten = false;
    let safeToResume = true;
    try {
      const before = await exportVault(root);
      if (fingerprint(before) !== preview.baseline) {
        this.preview = null;
        throw new CollectorError('invalid_request', '本機資料在比對後有變更，請重新比對。');
      }
      const changes = mergeFiles(packageFiles(before), packageFiles(preview.incoming), preview.value.items, choices);
      if (!changes.size) {
        this.preview = null;
        this.statusValue = { ...this.statusValue, state: 'completed', message: '合併完成，沒有需要寫入的變更。' };
        return;
      }
      const backup = `${root}.before-merge-${randomUUID()}.xr-vault`;
      await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
      await this.atomicFile(journal, Buffer.from(JSON.stringify({ backup, paths: [...changes.keys()] })));
      journalWritten = true;
      this.mergeWriting = true;
      this.statusValue = { state: 'extracting', message: '正在合併資料…', completedFiles: 0, totalFiles: changes.size };
      for (const [relative, bytes] of changes) {
        await this.atomicFile(path.join(root, relative), bytes);
        this.statusValue.completedFiles += 1;
      }
      this.statusValue = { ...this.statusValue, state: 'indexing', message: '正在增量更新搜尋…' };
      const vault = new MarkdownVault(root);
      for (const relative of changes.keys()) {
        if (!relative.startsWith('documents/')) continue;
        const document = await vault.read(`youtube:${path.basename(relative, '.md')}`);
        if (!document) throw new Error('Merged document missing');
        await this.current.runtime.search.index(document);
      }
      await this.reloadSchedule();
      await rm(journal);
      journalWritten = false;
      this.preview = null;
      this.statusValue = { ...this.statusValue, state: 'completed', message: `合併完成。合併前資料包：${backup}` };
    } catch (error) {
      if (journalWritten) {
        try {
          await this.recoverMerge(root);
          await this.current.runtime.search.rebuild();
          await this.reloadSchedule();
          await rm(journal);
        } catch {
          safeToResume = false;
          throw new CollectorError('vault_busy', `合併未完成，已停止寫入與排程。請重新啟動以復原；復原紀錄：${journal}`);
        }
      }
      throw error;
    } finally {
      if (safeToResume) { this.mergeWriting = false; this.locked = false; this.current.schedule.setSuspended(false); }
    }
  }

  private async reloadSchedule(): Promise<void> {
    await this.current.schedule.close();
    this.current.schedule = new ChannelScheduler(this.current.channels, new JsonChannelScheduleStore(this.current.root));
    this.current.schedule.setSuspended(true);
    await this.current.schedule.start();
  }

  private fail(error: unknown): void {
    this.statusValue = { ...this.statusValue, state: 'error', message: error instanceof CollectorError
      ? error.message : '資料搬移失敗，請確認資料包、磁碟空間與搜尋服務後重試。' };
  }

  /** Each Vault path gets its own rebuildable search database on this device. */
  private searchPath(root: string): string {
    return `${this.options.searchData}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  }

  private async makeBundle(root: string, port?: number): Promise<Bundle> {
    const vault = new MarkdownVault(root);
    const runtime = this.options.createSearch ? await this.options.createSearch(root) : await startSearchRuntime({
      vault, binaryPath: this.options.searchBinary, databasePath: this.searchPath(root),
      ...(port ? { port } : {}),
    });
    const collector = new Collector(this.options.capture, vault, runtime.search);
    const channels = new ChannelCollector(this.options.channelSource, new JsonChannelStore(root), collector);
    const schedule = new ChannelScheduler(channels, new JsonChannelScheduleStore(root));
    return { root, runtime, collector, channels, schedule };
  }

  async close(): Promise<void> {
    await this.operation;
    const drained = await Promise.allSettled([
      this.current.schedule.close(),
      this.current.channels.whenIdle(),
      this.current.collector.whenIdle(),
    ]);
    const search = await Promise.allSettled([this.current.runtime.close()]);
    const failed = [...drained, ...search].find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

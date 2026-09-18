import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Collector, type YouTubeCapture } from '../core/collector.js';
import { CollectorError, type TransferStatus, type TranscriptSearch } from '../core/types.js';
import { ChannelCollector, type YouTubeChannelSource } from '../channels/channel-collector.js';
import { ChannelScheduler } from '../channels/channel-scheduler.js';
import { JsonChannelStore } from '../channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../channels/json-channel-schedule-store.js';
import { startSearchRuntime, type SearchRuntime } from '../search/runtime.js';
import { MarkdownVault } from './markdown-vault.js';
import { exportVault, unpackVault } from './vault-package.js';

interface Bundle {
  root: string;
  collector: Collector;
  channels: ChannelCollector;
  schedule: ChannelScheduler;
  runtime: SearchRuntime;
}
interface WorkspaceOptions {
  defaultRoot: string;
  capture: YouTubeCapture;
  channelSource: YouTubeChannelSource;
  searchBinary: string;
  searchData: string;
  searchPort?: number;
  createSearch?: (root: string) => Promise<SearchRuntime>;
}

/** Service references stay stable for both UI and Agent while the active vault changes. */
function forwarding<T extends object>(target: () => T): T {
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
  private locked = false;
  private requests = 0;
  private operation: Promise<void> | null = null;
  private statusValue: Omit<TransferStatus, 'vaultPath'> = {
    state: 'idle', message: '', completedFiles: 0, totalFiles: 0,
  };
  readonly collector = forwarding(() => this.current.collector);
  readonly channels = forwarding(() => this.current.channels);
  readonly schedule = forwarding(() => this.current.schedule);
  readonly search = forwarding<TranscriptSearch>(() => this.current.runtime.search);
  private readonly selectionFile: string;
  private readonly restoreParent: string;

  private constructor(private readonly options: WorkspaceOptions) {
    this.selectionFile = `${options.defaultRoot}.active.json`;
    this.restoreParent = `${options.defaultRoot}.restored`;
  }

  static async open(options: WorkspaceOptions): Promise<VaultWorkspace> {
    const workspace = new VaultWorkspace(options);
    let root = options.defaultRoot;
    try {
      const selection: unknown = JSON.parse(await readFile(workspace.selectionFile, 'utf8'));
      if (!selection || typeof selection !== 'object' || !('name' in selection)
        || typeof selection.name !== 'string' || !/^vault-[A-Za-z0-9]+$/u.test(selection.name)) {
        throw new Error('Invalid active vault selection');
      }
      root = path.join(workspace.restoreParent, selection.name);
      // A missing restored vault must never silently become an empty writable vault.
      if (!(await stat(root)).isDirectory()) throw new Error('Active vault is missing');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || root !== options.defaultRoot) throw error;
    }
    workspace.current = await workspace.makeBundle(root, options.searchPort);
    await workspace.current.schedule.start();
    return workspace;
  }

  status(): TransferStatus { return { ...this.statusValue, vaultPath: this.current.root }; }

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
    this.operation = this.restoreOnce(buffer).catch((error: unknown) => this.fail(error)).finally(() => { this.operation = null; });
    return this.status();
  }

  private async restoreOnce(buffer: Buffer): Promise<void> {
    let destination: string | null = null;
    let candidate: Bundle | null = null;
    let temporary: string | null = null;
    try {
      await mkdir(this.restoreParent, { recursive: true, mode: 0o700 });
      destination = await mkdtemp(path.join(this.restoreParent, 'vault-'));
      await unpackVault(buffer, destination, (done, total) => {
        this.statusValue = { state: 'extracting', message: '正在還原檔案…', completedFiles: done, totalFiles: total };
      });
      this.statusValue = { ...this.statusValue, state: 'indexing', message: '正在重建新 vault 的搜尋索引…' };
      candidate = await this.makeBundle(destination);
      // The candidate owns a separate search database; failed preparation leaves the active vault intact.
      await candidate.runtime.search.rebuild();
      await candidate.schedule.getSchedule();
      temporary = `${this.selectionFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ name: path.basename(destination) }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.selectionFile);
      temporary = null;
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
        if (temporary) await rm(temporary, { force: true });
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

  private fail(error: unknown): void {
    this.statusValue = { ...this.statusValue, state: 'error', message: error instanceof CollectorError
      ? error.message : '資料搬移失敗，請確認資料包、磁碟空間與搜尋服務後重試。' };
  }

  private searchPath(root: string): string {
    return root === this.options.defaultRoot ? this.options.searchData
      : `${this.options.searchData}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
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
    await this.current.schedule.close();
    await this.current.runtime.close();
  }
}

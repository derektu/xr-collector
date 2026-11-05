import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserWindow, Dialog, FileFilter, IpcMain, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions, WebContents,
} from 'electron';
import type { TransferStatus } from '../core/vault-types.js';
import { exportFileName } from '../vault/transfer-files.js';

export interface DesktopDialogOptions {
  ipc: Pick<IpcMain, 'handle'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  /** The window a request came from, which owns its dialog. */
  windowOf(sender: WebContents): BrowserWindow | null;
  showItemInFolder(file: string): void;
  /** The Documents folder: where folder pickers start without a usable start, and the top of the walk up. */
  documents: string;
  /** Folder exports go to unless the person picks another place; the import dialog opens here too. */
  exports: string;
  /** The active Vault's operation status, or undefined while no Vault is open. */
  vaultStatus(): TransferStatus | undefined;
}

/**
 * The native dialogs the page asks for over IPC: folder pickers for a new or another Vault, the
 * export and import file dialogs, and revealing the Vault or the last export in the file manager.
 * Each returns only a path; creating, opening and checking go through the HTTP API.
 */
export function registerDesktopDialogs(options: DesktopDialogOptions): void {
  const { ipc, dialog } = options;
  /**
   * A folder picker for one purpose, starting at the existing folder nearest `start`. macOS shows
   * `message` above the panel, because its open panel shows no title.
   */
  const chooseFolder = async (event: IpcMainInvokeEvent, start: unknown, text: { title: string; buttonLabel: string; message: string },
    properties: NonNullable<OpenDialogOptions['properties']>): Promise<string | null> => {
    const owner = options.windowOf(event.sender);
    const dialogOptions: OpenDialogOptions = {
      ...text,
      defaultPath: await existingDirectory(typeof start === 'string' && path.isAbsolute(start) ? start : options.documents, options.documents),
      properties,
    };
    const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    return result.canceled ? null : result.filePaths[0] ?? null;
  };
  ipc.handle('xrCollector:desktop:chooseVaultLocation', (event, start: unknown) => chooseFolder(event, start, {
    title: '選擇位置', buttonLabel: '選擇位置', message: '選擇新的知識庫要建立在哪個資料夾裡。',
  }, ['openDirectory', 'createDirectory']));
  ipc.handle('xrCollector:desktop:chooseVault', (event, start: unknown) => chooseFolder(event, start, {
    title: '選擇知識庫資料夾', buttonLabel: '開啟', message: '選擇 XR Collector 知識庫資料夾。',
  }, ['openDirectory']));
  const exports = options.exports;
  const exportFilters: FileFilter[] = [{ name: 'XR Collector 匯出檔', extensions: ['zip'] }];
  ipc.handle('xrCollector:desktop:chooseExportFile', async (event) => {
    const owner = options.windowOf(event.sender);
    await mkdir(exports, { recursive: true });
    const dialogOptions: SaveDialogOptions = {
      title: '匯出知識庫',
      buttonLabel: '匯出',
      defaultPath: path.join(exports, exportFileName(new Date())),
      filters: exportFilters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = owner ? await dialog.showSaveDialog(owner, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return null;
    // The dialog confirmed replacing the file it showed. A name given the extension here was not
    // confirmed, so the export dialog asks before replacing a file of that name.
    return /\.zip$/iu.test(result.filePath)
      ? { path: result.filePath, overwrite: true }
      : { path: `${result.filePath}.zip`, overwrite: false };
  });
  ipc.handle('xrCollector:desktop:chooseImportFile', async (event) => {
    const owner = options.windowOf(event.sender);
    await mkdir(exports, { recursive: true });
    const dialogOptions: OpenDialogOptions = {
      title: '選擇匯出檔',
      buttonLabel: '選擇',
      message: '選擇 XR Collector 匯出的 .zip 檔。',
      defaultPath: exports,
      filters: exportFilters,
      properties: ['openFile'],
    };
    const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  // The folder comes from the runtime, never from the page, so the page can only reveal the active Vault.
  ipc.handle('xrCollector:desktop:revealVault', () => {
    const vaultPath = options.vaultStatus()?.vaultPath;
    if (vaultPath) options.showItemInFolder(vaultPath);
  });
  // Likewise the export file is the one the last finished export wrote, as the runtime reports it.
  ipc.handle('xrCollector:desktop:revealExport', () => {
    const status = options.vaultStatus();
    const exportPath = status?.operation === 'export' && status.state === 'completed' ? status.result?.exportPath : undefined;
    if (exportPath) options.showItemInFolder(exportPath);
  });
}

/**
 * Returns the closest existing directory at or above the given path, or `fallback` when none is.
 * The Windows folder dialog asks to create a missing default path as soon as it opens, so the
 * dialog starts in a folder that already exists.
 */
export async function existingDirectory(start: string, fallback: string): Promise<string> {
  let current = start;
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch { /* keep walking up */ }
    const parent = path.dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

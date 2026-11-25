import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserWindow, Dialog, FileFilter, IpcMain, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions, WebContents,
} from 'electron';
import type { TransferStatus } from '../../shared/vault/vault-types.js';
import { exportFileName } from '../../domain/vault/index.js';

export interface DesktopDialogOptions {
  ipc: Pick<IpcMain, 'handle'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  windowOf(sender: WebContents): BrowserWindow | null;
  showItemInFolder(file: string): void;
  documents: string;
  exports: string;
  vaultStatus(): TransferStatus | undefined;
}

export function registerDesktopDialogs(options: DesktopDialogOptions): void {
  const { ipc, dialog } = options;
  // External: Electron shows `message` only on macOS, above the dialog's input boxes.
  // https://github.com/electron/electron/blob/v44.10.0/docs/api/dialog.md
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
    return /\.zip$/iu.test(result.filePath)
      ? { path: result.filePath, overwriteConfirmed: true }
      : { path: `${result.filePath}.zip`, overwriteConfirmed: false };
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
  ipc.handle('xrCollector:desktop:revealVault', () => {
    const vaultPath = options.vaultStatus()?.vaultPath;
    if (vaultPath) options.showItemInFolder(vaultPath);
  });
  ipc.handle('xrCollector:desktop:revealTransferFile', () => {
    const file = transferFile(options.vaultStatus());
    if (file) options.showItemInFolder(file);
  });
}

function transferFile(status: TransferStatus | undefined): string | undefined {
  if (status?.operation === 'export' && status.state === 'completed') return status.result?.exportPath;
  if (status?.operation === 'import' && status.state === 'error' && status.result?.partiallyApplied) return status.result.backupPath;
  return undefined;
}

// External: The Windows folder dialog asks whether to create its default path when that folder does not exist, as soon as it opens.
export async function existingDirectory(start: string, fallback: string): Promise<string> {
  let current = start;
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

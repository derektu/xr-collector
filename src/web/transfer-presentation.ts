import type { ImportConflict, ImportCounts, ImportSide, ImportSituation, SyncPointSummary, TransferStatus } from '../core/types.js';
import { dateTimeLabel } from './document-presentation.js';

const pad = (value: number) => String(value).padStart(2, '0');
const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const time = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const clock = (date: Date) => `${day(date)} ${time(date)}`;

/** "上次匯出 10-19 14:03" or "上次匯入 10-19 14:03"; a Vault without a sync point says so. */
export function lastSyncLabel(sync: SyncPointSummary | null): string {
  if (!sync) return '尚未匯出或匯入';
  const at = new Date(sync.at);
  return `上次${sync.kind === 'export' ? '匯出' : '匯入'} ${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time(at)}`;
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).pop() ?? filePath;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** What an export left out: files in the Vault folder that belong to no record of the Vault. */
export function unregisteredText(count: number): string {
  return `${count} 個非知識庫檔案未包含。`;
}

/** The move target for a chosen parent folder: the parent with the Vault folder's own name. */
export function moveTargetIn(parent: string, vaultPath: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/u, '')}${separator}${fileName(vaultPath.replace(/[\\/]+$/u, ''))}`;
}

/** The button that shows a folder in the file manager of `platform` (a Node.js platform name). */
export function revealLabel(platform: string): string {
  return platform === 'darwin' ? '在 Finder 顯示' : platform === 'win32' ? '在檔案總管顯示' : '在檔案管理員顯示';
}

/** The operations that switch the Vault in use and therefore reload the app when they complete. */
export function relocates(status: Pick<TransferStatus, 'operation'> | null): boolean {
  return status?.operation === 'move' || status?.operation === 'open';
}

/** Whether a transfer is still running and the dialog should keep polling. */
export function transferRunning(status: Pick<TransferStatus, 'state'> | null): boolean {
  return !!status && !['idle', 'completed', 'error'].includes(status.state);
}

/** One line of progress: the status message with the file count while files are written. */
export function progressText(status: Pick<TransferStatus, 'state' | 'message' | 'completedFiles' | 'totalFiles'>): string {
  return (status.state === 'extracting' || status.state === 'copying') && status.totalFiles > 0
    ? `${status.message}（${status.completedFiles}／${status.totalFiles}）`
    : status.message;
}

/** "新增 3、修改 1、刪除 2". */
export function countsText(counts: ImportCounts): string {
  return `新增 ${counts.added}、修改 ${counts.modified}、刪除 ${counts.removed}`;
}

/** "2026-10-19 14:03 匯出", for the export file being imported; null when the file has no export time. */
export function sourceText(source: { exportedAt: string | null }): string | null {
  return source.exportedAt ? `${clock(new Date(source.exportedAt))} 匯出` : null;
}

/** The sentence an import shows above its choices; a file whose changes simply apply needs none. */
export function situationText(situation: ImportSituation): string | null {
  return {
    incoming: null,
    both: null,
    unrelated: '這個檔案來自另一個知識庫，合併只新增、不刪除。',
    nothing: '沒有需要匯入的內容。',
  }[situation];
}

/**
 * One side of a conflict: "本機・2026-10-19 14:03:07", "匯入檔・已刪除・時間不明", or
 * "本機・沒有這一項" for a side without the item, which has no time to show.
 */
export function sideText(label: string, side: ImportSide): string {
  if (side.state === 'absent') return `${label}・沒有這一項`;
  const state = side.state === 'deleted' ? '・已刪除' : '';
  return `${label}${state}・${side.time ? dateTimeLabel(side.time) : '時間不明'}`;
}

/** The kind of a conflict, named for people. */
export function conflictKind(conflict: Pick<ImportConflict, 'kind'>): string {
  return conflict.kind === 'channel' ? '訂閱' : '文件';
}

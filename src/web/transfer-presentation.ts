import type { ChangeCounts, ItemCounts, TransferStatus } from '../core/types.js';

const pad = (value: number) => String(value).padStart(2, '0');
const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const time = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const clock = (date: Date) => `${day(date)} ${time(date)}`;

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).pop() ?? filePath;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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

/** Whether an import changes anything a person sees. */
export function hasChanges(counts: ChangeCounts): boolean {
  return [counts.documents, counts.subscriptions].some((kind) => kind.added + kind.updated + kind.removed > 0);
}

const nouns = { documents: '份文件', subscriptions: '個訂閱' } as const;

function verbText(verb: string, field: keyof ItemCounts, counts: ChangeCounts): string | null {
  const parts = (['documents', 'subscriptions'] as const).filter((kind) => counts[kind][field] > 0)
    .map((kind) => `${counts[kind][field]} ${nouns[kind]}`);
  return parts.length ? `${verb} ${parts.join('、')}` : null;
}

/** "新增 5 份文件、1 個訂閱；更新 2 份文件；刪除 1 份文件"; "沒有變更" when nothing changes. */
export function changeText(counts: ChangeCounts): string {
  return [verbText('新增', 'added', counts), verbText('更新', 'updated', counts), verbText('刪除', 'removed', counts)]
    .filter(Boolean).join('；') || '沒有變更';
}

/** "會移除 1 份文件、1 個訂閱" for a replace that removes local items; null when it removes none. */
export function removalText(counts: ChangeCounts): string | null {
  return verbText('會移除', 'removed', counts);
}

/** "本機有 6 項較新的修改或刪除". */
export function localNewerText(count: number): string {
  return `本機有 ${count} 項較新的修改或刪除`;
}

/** "2026-10-19 14:03 匯出", for the export file being imported; null when the file has no export time. */
export function sourceText(source: { exportedAt: string | null }): string | null {
  return source.exportedAt ? `${clock(new Date(source.exportedAt))} 匯出` : null;
}

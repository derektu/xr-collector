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

/** The file manager of `platform` (a Node.js platform name). */
export function fileManager(platform: string): 'finder' | 'explorer' | 'other' {
  return platform === 'darwin' ? 'finder' : platform === 'win32' ? 'explorer' : 'other';
}

/** The button that shows a folder in the file manager of `platform`. */
export function revealLabel(platform: string): string {
  const names = { finder: '在 Finder 顯示', explorer: '在檔案總管顯示', other: '在檔案管理員顯示' } as const;
  return names[fileManager(platform)];
}

/** Whether the operation switches the Vault in use and therefore reloads the app when it completes. */
export function relocates(status: Pick<TransferStatus, 'operation'> | null): boolean {
  return status?.operation === 'open' || status?.operation === 'create';
}

/** Whether a transfer is still running and the dialog should keep polling. */
export function transferRunning(status: Pick<TransferStatus, 'state'> | null): boolean {
  return !!status && !['idle', 'completed', 'error'].includes(status.state);
}

/** The files written so far while an import extracts them; null otherwise. */
export function fileProgress(status: Pick<TransferStatus, 'state' | 'completedFiles' | 'totalFiles'>): { completed: number; total: number } | null {
  return status.state === 'extracting' && status.totalFiles > 0 ? { completed: status.completedFiles, total: status.totalFiles } : null;
}

/** One line of progress: the status message with the file count while files are written. */
export function progressText(status: Pick<TransferStatus, 'state' | 'message' | 'completedFiles' | 'totalFiles'>): string {
  const files = fileProgress(status);
  return files ? `${status.message}（${files.completed}／${files.total}）` : status.message;
}

/** Whether an import changes anything a person sees. */
export function hasChanges(counts: ChangeCounts): boolean {
  return [counts.documents, counts.subscriptions].some((kind) => kind.added + kind.updated + kind.removed > 0);
}

/** How many documents and subscriptions one kind of change touches, leaving out kinds it does not touch. */
export type ChangeParts = Array<{ kind: 'documents' | 'subscriptions'; count: number }>;

/** What an import adds, updates and removes, by kind. */
export function changes(counts: ChangeCounts): Record<keyof ItemCounts, ChangeParts> {
  const parts = (field: keyof ItemCounts): ChangeParts => (['documents', 'subscriptions'] as const)
    .filter((kind) => counts[kind][field] > 0).map((kind) => ({ kind, count: counts[kind][field] }));
  return { added: parts('added'), updated: parts('updated'), removed: parts('removed') };
}

const nouns = { documents: '份文件', subscriptions: '個訂閱' } as const;

function partsText(verb: string, parts: ChangeParts): string | null {
  return parts.length ? `${verb} ${parts.map((part) => `${part.count} ${nouns[part.kind]}`).join('、')}` : null;
}

/** "新增 5 份文件、1 個訂閱；更新 2 份文件；刪除 1 份文件"; "沒有變更" when nothing changes. */
export function changeText(counts: ChangeCounts): string {
  const change = changes(counts);
  return [partsText('新增', change.added), partsText('更新', change.updated), partsText('刪除', change.removed)]
    .filter(Boolean).join('；') || '沒有變更';
}

/** "會移除 1 份文件、1 個訂閱" for a replace that removes local items; null when it removes none. */
export function removalText(counts: ChangeCounts): string | null {
  return partsText('會移除', changes(counts).removed);
}

/** "本機有 6 項較新的修改或刪除". */
export function localNewerText(count: number): string {
  return `本機有 ${count} 項較新的修改或刪除`;
}

/** The local time an export file was made, "2026-10-19 14:03"; null when the file has no export time. */
export function exportTime(source: { exportedAt: string | null }): string | null {
  return source.exportedAt ? clock(new Date(source.exportedAt)) : null;
}

/** "2026-10-19 14:03 匯出", for the export file being imported; null when the file has no export time. */
export function sourceText(source: { exportedAt: string | null }): string | null {
  const time = exportTime(source);
  return time ? `${time} 匯出` : null;
}

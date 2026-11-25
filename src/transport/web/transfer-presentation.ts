import type { DesktopPlatform } from '../../shared/api/device-types.js';
import type { ChangeCounts, ItemCounts, PackageDescription, TransferStatus } from '../../shared/vault/vault-types.js';

const pad = (value: number) => String(value).padStart(2, '0');
const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const time = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const clock = (date: Date) => `${day(date)} ${time(date)}`;

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).pop() ?? filePath;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function fileManager(platform: DesktopPlatform): 'finder' | 'explorer' | 'other' {
  return platform === 'darwin' ? 'finder' : platform === 'win32' ? 'explorer' : 'other';
}

export function revealLabel(platform: DesktopPlatform): string {
  const names = { finder: '在 Finder 顯示', explorer: '在檔案總管顯示', other: '在檔案管理員顯示' } as const;
  return names[fileManager(platform)];
}

export function switchesVault(status: Pick<TransferStatus, 'operation'> | null): boolean {
  return status?.operation === 'open' || status?.operation === 'create';
}

export function transferRunning(status: Pick<TransferStatus, 'state'> | null): boolean {
  return !!status && !['idle', 'completed', 'error'].includes(status.state);
}

export function relocationPhase(status: Pick<TransferStatus, 'state'>): 'done' | 'failed' {
  return status.state === 'completed' ? 'done' : 'failed';
}

export type ImportApplyOutcome =
  | { kind: 'imported' }
  | { kind: 'unchanged'; reason: string }
  | { kind: 'partial'; backupPath: string };

export function importApplyOutcome(status: Pick<TransferStatus, 'state' | 'message' | 'result'>): ImportApplyOutcome {
  if (status.state !== 'error') return { kind: 'imported' };
  const backupPath = status.result?.partiallyApplied ? status.result.backupPath : undefined;
  return backupPath ? { kind: 'partial', backupPath } : { kind: 'unchanged', reason: status.message };
}

export function fileProgress(status: Pick<TransferStatus, 'state' | 'completedFiles' | 'totalFiles'>): { completed: number; total: number } | null {
  return status.state === 'extracting' && status.totalFiles > 0 ? { completed: status.completedFiles, total: status.totalFiles } : null;
}

export function progressText(status: Pick<TransferStatus, 'state' | 'message' | 'completedFiles' | 'totalFiles'>): string {
  const files = fileProgress(status);
  return files ? `${status.message}（${files.completed}／${files.total}）` : status.message;
}

export function hasChanges(counts: ChangeCounts): boolean {
  return [counts.documents, counts.subscriptions].some((kind) => kind.added + kind.updated + kind.removed > 0);
}

export type ChangeParts = Array<{ kind: 'documents' | 'subscriptions'; count: number }>;

export function changes(counts: ChangeCounts): Record<keyof ItemCounts, ChangeParts> {
  const parts = (field: keyof ItemCounts): ChangeParts => (['documents', 'subscriptions'] as const)
    .filter((kind) => counts[kind][field] > 0).map((kind) => ({ kind, count: counts[kind][field] }));
  return { added: parts('added'), updated: parts('updated'), removed: parts('removed') };
}

const nouns = { documents: '份文件', subscriptions: '個訂閱' } as const;

function partsText(verb: string, parts: ChangeParts): string | null {
  return parts.length ? `${verb} ${parts.map((part) => `${part.count} ${nouns[part.kind]}`).join('、')}` : null;
}

export function changeText(counts: ChangeCounts): string {
  const change = changes(counts);
  return [partsText('新增', change.added), partsText('更新', change.updated), partsText('刪除', change.removed)]
    .filter(Boolean).join('；') || '沒有變更';
}

export function localNewerText(count: number): string {
  return `本機有 ${count} 項較新的修改或刪除`;
}

export function exportTime(source: { exportedAt: string | null }): string | null {
  return source.exportedAt ? clock(new Date(source.exportedAt)) : null;
}

export function sourceText(source: { exportedAt: string | null }): string | null {
  const time = exportTime(source);
  return time ? `${time} 匯出` : null;
}

export function packageSummary(described: PackageDescription): string {
  const exported = described.exportedAt ? new Date(described.exportedAt) : null;
  const date = exported && !Number.isNaN(exported.getTime()) ? day(exported) : '';
  return `${date ? `${date} 匯出，` : ''}${described.documents} 份文件、${described.subscriptions} 個訂閱`;
}

import type { MergeItem, TransferStatus } from '../core/types.js';
import { dateTimeLabel } from './document-presentation.js';

const pad = (value: number) => String(value).padStart(2, '0');
const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** "上次匯出 2026-10-01 14:03"; a Vault this device never exported says so. */
export function lastExportLabel(value: string | null): string {
  if (!value) return '尚未匯出';
  const date = new Date(value);
  return `上次匯出 ${day(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function exportFileName(now: Date): string {
  return `XR Collector 備份 ${day(now)}.xr-vault`;
}

/** A path beside `vaultPath`, written with the separator the Vault path uses. */
export function besideVault(vaultPath: string, name: string): string {
  const separator = vaultPath.includes('\\') && !vaultPath.includes('/') ? '\\' : '/';
  const trimmed = vaultPath.replace(/[\\/]+$/u, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return `${cut >= 0 ? trimmed.slice(0, cut) : trimmed}${separator}${name}`;
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

const GROUP_TITLES: Record<MergeItem['kind'], string> = {
  document: '文件', channel: '訂閱', deletion: '刪除紀錄', file: '其他檔案',
};
const GROUP_ORDER: MergeItem['kind'][] = ['document', 'channel', 'deletion', 'file'];

export interface MergeGroup {
  kind: MergeItem['kind'];
  title: string;
  /** New items and items that need a choice; identical items are only counted. */
  items: MergeItem[];
  same: number;
}

export function mergeCounts(items: MergeItem[]): { added: number; same: number; conflicts: number } {
  return {
    added: items.filter((item) => item.state === 'new').length,
    same: items.filter((item) => item.state === 'same').length,
    conflicts: items.filter((item) => item.state === 'conflict').length,
  };
}

/** Items by kind, choices first, leaving out kinds the package and the Vault do not differ in. */
export function mergeGroups(items: MergeItem[]): MergeGroup[] {
  return GROUP_ORDER.map((kind) => {
    const ofKind = items.filter((item) => item.kind === kind);
    const shown = ofKind.filter((item) => item.state !== 'same')
      .sort((a, b) => Number(b.state === 'conflict') - Number(a.state === 'conflict'));
    return { kind, title: GROUP_TITLES[kind], items: shown, same: ofKind.length - shown.length };
  }).filter((group) => group.items.length > 0 || group.same > 0);
}

/** The name of an item without the kind prefix its group heading already says. */
export function itemName(item: MergeItem): string {
  return item.kind === 'deletion' ? item.label.replace(/^刪除紀錄：/u, '') : item.label;
}

/** What a difference is, and what each choice keeps, in the words of its kind. */
export function choiceText(item: MergeItem): { summary: string; local: string; incoming: string } {
  if (item.state === 'new') {
    const added: Record<MergeItem['kind'], string> = {
      document: '備份中的新文件，會加入知識庫。',
      channel: '備份中的新訂閱，會連同它的收集設定與進度加入。',
      deletion: '備份中的刪除紀錄，這份文件以後不會被自動收集抓回。',
      file: '備份中的新檔案，會加入知識庫。',
    };
    return { summary: added[item.kind], local: '', incoming: '' };
  }
  if (item.kind === 'deletion') {
    return item.deletedOn === 'local'
      ? { summary: '這份文件在本機已刪除，備份中仍有內容。', local: '維持刪除', incoming: '復原文件' }
      : { summary: '這份文件在備份中已刪除，本機仍保留。', local: '保留文件', incoming: '套用刪除' };
  }
  if (item.kind === 'channel') {
    return { summary: '兩邊的名稱、網址、暫停狀態或收集設定不同；收集進度一律保留本機。', local: '保留本機設定', incoming: '採用備份設定' };
  }
  if (item.kind === 'document') return { summary: '兩邊的內容不同。', local: '保留本機版本', incoming: '採用備份版本' };
  return { summary: '兩邊的檔案內容不同。', local: '保留本機版本', incoming: '採用備份版本' };
}

/** "本機 2026-10-01 14:03:05・備份 2026-10-02 09:00:00", for the times an item has. */
export function itemTimes(item: Pick<MergeItem, 'localTime' | 'incomingTime'>): string {
  const label = (value: string | null) => {
    if (!value) return '未提供';
    return Number.isNaN(Date.parse(value)) ? value : dateTimeLabel(value);
  };
  return `本機 ${label(item.localTime)}・備份 ${label(item.incomingTime)}`;
}

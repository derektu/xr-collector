import { describe, expect, it } from 'vitest';
import type { MergeItem } from '../../src/core/types.js';
import {
  besideVault, choiceText, exportFileName, itemName, lastExportLabel, mergeCounts, mergeGroups, moveTargetIn, progressText, relocates, revealLabel, sizeLabel,
  transferRunning,
} from '../../src/web/transfer-presentation.js';

const item = (fields: Partial<MergeItem>): MergeItem => ({
  key: 'k', kind: 'document', label: '標題 (abc.md)', state: 'new', localTime: null, incomingTime: null, localText: '', incomingText: '', ...fields,
});

describe('backup presentation', () => {
  it('names files and places them beside the Vault', () => {
    expect(exportFileName(new Date(2026, 9, 16, 9))).toBe('XR Collector 備份 2026-10-16.xr-vault');
    expect(besideVault('/Users/a/Documents/XR Collector', 'b.xr-vault')).toBe('/Users/a/Documents/b.xr-vault');
    expect(besideVault('C:\\Users\\a\\XR Collector\\', 'b.xr-vault')).toBe('C:\\Users\\a\\b.xr-vault');
    expect(lastExportLabel(null)).toBe('尚未匯出');
    expect(lastExportLabel(new Date(2026, 9, 1, 14, 3).toISOString())).toBe('上次匯出 2026-10-01 14:03');
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2.0 KB');
  });

  it('reports progress while a transfer runs', () => {
    expect(transferRunning({ state: 'waiting' })).toBe(true);
    expect(transferRunning({ state: 'completed' })).toBe(false);
    expect(progressText({ state: 'extracting', message: '正在還原檔案…', completedFiles: 3, totalFiles: 9 })).toBe('正在還原檔案…（3／9）');
    expect(progressText({ state: 'waiting', message: '正在等待目前的收集步驟完成…', completedFiles: 0, totalFiles: 0 })).toBe('正在等待目前的收集步驟完成…');
  });

  it('groups merge items by kind with choices first and only counts identical ones', () => {
    const items = [
      item({ key: 'a', state: 'same' }), item({ key: 'b', state: 'new' }), item({ key: 'c', state: 'conflict' }),
      item({ key: 'd', kind: 'deletion', label: '刪除紀錄：舊影片', state: 'conflict', deletedOn: 'local' }),
      item({ key: 'e', kind: 'channel', state: 'same' }),
    ];
    expect(mergeCounts(items)).toEqual({ added: 1, same: 2, conflicts: 2 });
    expect(mergeGroups(items).map((group) => [group.title, group.items.map((entry) => entry.key), group.same])).toEqual([
      ['文件', ['c', 'b'], 1], ['訂閱', [], 1], ['刪除紀錄', ['d'], 0],
    ]);
    expect(itemName(items[3]!)).toBe('舊影片');
  });

  it('words each choice by what it keeps', () => {
    expect(choiceText(item({ kind: 'deletion', state: 'conflict', deletedOn: 'local' }))).toMatchObject({ local: '維持刪除', incoming: '復原文件' });
    expect(choiceText(item({ kind: 'deletion', state: 'conflict', deletedOn: 'incoming' }))).toMatchObject({ local: '保留文件', incoming: '套用刪除' });
    expect(choiceText(item({ kind: 'channel', state: 'conflict' })).summary).toContain('收集進度一律保留本機');
    expect(choiceText(item({ kind: 'document', state: 'conflict' }))).toMatchObject({ local: '保留本機版本', incoming: '採用備份版本' });
  });

  it('names move targets, the file manager and the operations that switch Vaults', () => {
    expect(moveTargetIn('/Volumes/Backup', '/Users/a/Documents/XR Collector')).toBe('/Volumes/Backup/XR Collector');
    expect(moveTargetIn('/Volumes/Backup/', '/Users/a/XR Collector/')).toBe('/Volumes/Backup/XR Collector');
    expect(moveTargetIn('D:\\Data', 'C:\\Users\\a\\XR Collector')).toBe('D:\\Data\\XR Collector');
    expect(revealLabel('darwin')).toBe('在 Finder 顯示');
    expect(revealLabel('win32')).toBe('在檔案總管顯示');
    expect(relocates({ operation: 'move' })).toBe(true);
    expect(relocates({ operation: 'restore' })).toBe(false);
    expect(progressText({ state: 'copying', message: '正在複製檔案…', completedFiles: 4, totalFiles: 10 })).toBe('正在複製檔案…（4／10）');
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

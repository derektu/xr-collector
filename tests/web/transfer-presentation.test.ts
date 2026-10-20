import { describe, expect, it } from 'vitest';
import {
  changeText, hasChanges, localNewerText, moveTargetIn, progressText, relocates, removalText, revealLabel, sizeLabel, sourceText,
  transferRunning,
} from '../../src/web/transfer-presentation.js';

const counts = (documents: Partial<Record<'added' | 'updated' | 'removed', number>>, subscriptions: Partial<Record<'added' | 'updated' | 'removed', number>> = {}) => ({
  documents: { added: 0, updated: 0, removed: 0, ...documents }, subscriptions: { added: 0, updated: 0, removed: 0, ...subscriptions },
});

describe('export and import presentation', () => {
  it('names sizes', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2.0 KB');
  });

  it('reports progress while a transfer runs', () => {
    expect(transferRunning({ state: 'waiting' })).toBe(true);
    expect(transferRunning({ state: 'completed' })).toBe(false);
    expect(progressText({ state: 'extracting', message: '正在套用匯入的內容…', completedFiles: 3, totalFiles: 9 })).toBe('正在套用匯入的內容…（3／9）');
    expect(progressText({ state: 'waiting', message: '正在等待目前的收集步驟完成…', completedFiles: 0, totalFiles: 0 })).toBe('正在等待目前的收集步驟完成…');
  });

  it('counts what an import changes by kind, in as few words as a decision needs', () => {
    expect(changeText(counts({ added: 5, updated: 2, removed: 1 }, { added: 1 }))).toBe('新增 5 份文件、1 個訂閱；更新 2 份文件；刪除 1 份文件');
    expect(changeText(counts({}, { removed: 2 }))).toBe('刪除 2 個訂閱');
    expect(changeText(counts({}))).toBe('沒有變更');
    expect(hasChanges(counts({}))).toBe(false);
    expect(hasChanges(counts({}, { updated: 1 }))).toBe(true);
    expect(removalText(counts({ removed: 1 }, { removed: 1 }))).toBe('會移除 1 份文件、1 個訂閱');
    expect(removalText(counts({ added: 3 }))).toBeNull();
    expect(localNewerText(6)).toBe('本機有 6 項較新的修改或刪除');
    expect(sourceText({ exportedAt: new Date(2026, 9, 19, 9, 5).toISOString() })).toBe('2026-10-19 09:05 匯出');
    expect(sourceText({ exportedAt: null })).toBeNull();
  });

  it('names move targets, the file manager and the operations that switch Vaults', () => {
    expect(moveTargetIn('/Volumes/Backup', '/Users/a/Documents/XR Collector')).toBe('/Volumes/Backup/XR Collector');
    expect(moveTargetIn('/Volumes/Backup/', '/Users/a/XR Collector/')).toBe('/Volumes/Backup/XR Collector');
    expect(moveTargetIn('D:\\Data', 'C:\\Users\\a\\XR Collector')).toBe('D:\\Data\\XR Collector');
    expect(revealLabel('darwin')).toBe('在 Finder 顯示');
    expect(revealLabel('win32')).toBe('在檔案總管顯示');
    expect(relocates({ operation: 'move' })).toBe(true);
    expect(relocates({ operation: 'import' })).toBe(false);
    expect(progressText({ state: 'copying', message: '正在複製檔案…', completedFiles: 4, totalFiles: 10 })).toBe('正在複製檔案…（4／10）');
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

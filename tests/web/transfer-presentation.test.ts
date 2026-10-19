import { describe, expect, it } from 'vitest';
import {
  conflictKind, countsText, lastSyncLabel, moveTargetIn, progressText, relocates, revealLabel, sideText, situationText, sizeLabel, sourceText,
  transferRunning, unregisteredText,
} from '../../src/web/transfer-presentation.js';

describe('export and import presentation', () => {
  it('names the newest sync point, sizes and what an export left out', () => {
    expect(lastSyncLabel(null)).toBe('尚未匯出或匯入');
    const at = new Date(2026, 9, 1, 14, 3).toISOString();
    expect(lastSyncLabel({ at, kind: 'export', machine: '家裡 Mac' })).toBe('上次同步 2026-10-01 14:03（匯出）');
    expect(lastSyncLabel({ at, kind: 'import', machine: '公司 Mac' })).toBe('上次同步 2026-10-01 14:03（匯入自 公司 Mac）');
    expect(lastSyncLabel({ at, kind: 'import', machine: null })).toBe('上次同步 2026-10-01 14:03（匯入）');
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2.0 KB');
    expect(unregisteredText(2)).toBe('知識庫資料夾中有 2 個不屬於知識庫的檔案沒有包含在匯出檔裡。');
  });

  it('reports progress while a transfer runs', () => {
    expect(transferRunning({ state: 'waiting' })).toBe(true);
    expect(transferRunning({ state: 'completed' })).toBe(false);
    expect(progressText({ state: 'extracting', message: '正在套用匯入的內容…', completedFiles: 3, totalFiles: 9 })).toBe('正在套用匯入的內容…（3／9）');
    expect(progressText({ state: 'waiting', message: '正在等待目前的收集步驟完成…', completedFiles: 0, totalFiles: 0 })).toBe('正在等待目前的收集步驟完成…');
  });

  it('describes what an import found and where the file came from', () => {
    expect(countsText({ added: 3, modified: 1, removed: 2 })).toBe('新增 3、修改 1、刪除 2');
    expect(sourceText({ machine: '公司 Mac', exportedAt: new Date(2026, 9, 19, 9, 5).toISOString() })).toBe('公司 Mac 於 2026-10-19 09:05 匯出');
    expect(sourceText({ machine: null, exportedAt: null })).toBe('另一台電腦 匯出');
    expect(situationText('incoming')).toContain('直接套用');
    expect(situationText('unrelated')).toContain('沒有共同的同步點');
    expect(situationText('nothing')).toContain('沒有需要匯入的內容');
  });

  it('shows each side of a conflict with its machine and time, or says the time is unknown', () => {
    const time = new Date(2026, 9, 19, 14, 3, 7).toISOString();
    expect(sideText('本機', { state: 'present', time, machine: '家裡 Mac' })).toBe('本機（家裡 Mac）・2026-10-19 14:03:07');
    expect(sideText('匯入檔', { state: 'deleted', time: null, machine: null })).toBe('匯入檔・已刪除・時間不明');
    expect(sideText('本機', { state: 'absent', time: null, machine: '家裡 Mac' })).toBe('本機（家裡 Mac）・沒有這一項');
    expect(conflictKind({ kind: 'channel' })).toBe('訂閱');
    expect(conflictKind({ kind: 'document' })).toBe('文件');
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

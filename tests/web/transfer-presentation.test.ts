// How export and import read in the window: file sizes, file progress while an import writes,
// what an import adds, updates and removes by kind, the export time, the platform's file manager,
// and which operations switch the Vault.
import { describe, expect, it } from 'vitest';
import {
  changes, exportTime, fileManager, fileProgress, hasChanges, relocates, sizeLabel, transferRunning,
} from '../../src/web/transfer-presentation.js';

const counts = (documents: Partial<Record<'added' | 'updated' | 'removed', number>>, subscriptions: Partial<Record<'added' | 'updated' | 'removed', number>> = {}) => ({
  documents: { added: 0, updated: 0, removed: 0, ...documents }, subscriptions: { added: 0, updated: 0, removed: 0, ...subscriptions },
});

describe('export and import presentation', () => {
  it('names sizes', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2.0 KB');
    expect(sizeLabel(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('reports progress while a transfer runs, counting files only while an import writes them', () => {
    expect(transferRunning({ state: 'waiting' })).toBe(true);
    expect(transferRunning({ state: 'completed' })).toBe(false);
    expect(fileProgress({ state: 'extracting', completedFiles: 3, totalFiles: 9 })).toEqual({ completed: 3, total: 9 });
    expect(fileProgress({ state: 'extracting', completedFiles: 0, totalFiles: 0 })).toBeNull();
    expect(fileProgress({ state: 'exporting', completedFiles: 3, totalFiles: 9 })).toBeNull();
  });

  it('counts what an import changes by kind, leaving out what it does not touch', () => {
    expect(changes(counts({ added: 5, updated: 2, removed: 1 }, { added: 1 }))).toEqual({
      added: [{ kind: 'documents', count: 5 }, { kind: 'subscriptions', count: 1 }],
      updated: [{ kind: 'documents', count: 2 }],
      removed: [{ kind: 'documents', count: 1 }],
    });
    expect(changes(counts({}, { removed: 2 }))).toEqual({ added: [], updated: [], removed: [{ kind: 'subscriptions', count: 2 }] });
    expect(changes(counts({}))).toEqual({ added: [], updated: [], removed: [] });
    expect(hasChanges(counts({}))).toBe(false);
    expect(hasChanges(counts({}, { updated: 1 }))).toBe(true);
    expect(exportTime({ exportedAt: new Date(2026, 9, 19, 9, 5).toISOString() })).toBe('2026-10-19 09:05');
    expect(exportTime({ exportedAt: null })).toBeNull();
  });

  it('names the file manager and the operations that switch Vaults', () => {
    expect(fileManager('darwin')).toBe('finder');
    expect(fileManager('win32')).toBe('explorer');
    expect(fileManager('linux')).toBe('other');
    expect(relocates({ operation: 'open' })).toBe(true);
    expect(relocates({ operation: 'create' })).toBe(true);
    expect(relocates({ operation: 'import' })).toBe(false);
  });
});

// The native dialogs the page asks for over IPC: a folder picker starts at the nearest existing
// folder, the export dialog adds `.zip` and then asks before replacing, a canceled dialog returns
// null, and revealing shows only the folder or export file the runtime reports.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, Dialog, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransferStatus } from '../../src/core/vault-types.js';
import { registerDesktopDialogs } from '../../src/electron/desktop-dialogs.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'xr-dialogs-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function dialogs(options: { status?: TransferStatus; save?: string | null; open?: string | null } = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const shown: { kind: 'open' | 'save'; owner: unknown; options: Record<string, unknown> }[] = [];
  const revealed: string[] = [];
  const owner = {} as BrowserWindow;
  const record = (kind: 'open' | 'save', args: unknown[]) => {
    const [first, second] = args;
    shown.push(second ? { kind, owner: first, options: second as Record<string, unknown> } : { kind, owner: null, options: first as Record<string, unknown> });
  };
  const dialog = {
    showOpenDialog: async (...args: unknown[]) => {
      record('open', args);
      return options.open ? { canceled: false, filePaths: [options.open] } : { canceled: true, filePaths: [] };
    },
    showSaveDialog: async (...args: unknown[]) => {
      record('save', args);
      return options.save ? { canceled: false, filePath: options.save } : { canceled: true, filePath: '' };
    },
  } as unknown as Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  registerDesktopDialogs({
    ipc: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => { handlers.set(channel, handler); } } as never,
    dialog,
    windowOf: () => owner,
    showItemInFolder: (file) => { revealed.push(file); },
    documents: path.join(root, 'Documents'),
    exports: path.join(root, 'Documents', 'XR Collector 匯出'),
    vaultStatus: () => options.status,
  });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {} } as IpcMainInvokeEvent, ...args);
  return { handlers, shown, revealed, owner, invoke };
}

describe('desktop dialogs', () => {
  it('registers every dialog channel the preload exposes', () => {
    expect([...dialogs().handlers.keys()].sort()).toEqual([
      'xrCollector:desktop:chooseExportFile', 'xrCollector:desktop:chooseImportFile', 'xrCollector:desktop:chooseVault',
      'xrCollector:desktop:chooseVaultLocation', 'xrCollector:desktop:revealExport', 'xrCollector:desktop:revealVault',
    ]);
  });

  it('starts a folder picker at the nearest existing folder, or Documents for a relative start', async () => {
    const existing = path.join(root, 'Vaults');
    await mkdir(existing);
    const subject = dialogs({ open: existing });
    expect(await subject.invoke('xrCollector:desktop:chooseVault', path.join(existing, 'missing', 'deeper'))).toBe(existing);
    expect(subject.shown[0]).toMatchObject({ kind: 'open', owner: subject.owner, options: { defaultPath: existing, properties: ['openDirectory'] } });

    await subject.invoke('xrCollector:desktop:chooseVaultLocation', 'relative/path');
    // Documents does not exist either, so the walk up from it ends at the nearest folder that does.
    expect(subject.shown[1]!.options).toMatchObject({ defaultPath: root, properties: ['openDirectory', 'createDirectory'] });
  });

  it('adds .zip to an export name and asks before replacing it, but keeps a name the dialog confirmed', async () => {
    const plain = dialogs({ save: path.join(root, 'backup') });
    expect(await plain.invoke('xrCollector:desktop:chooseExportFile')).toEqual({ path: path.join(root, 'backup.zip'), overwrite: false });
    const zipped = dialogs({ save: path.join(root, 'backup.ZIP') });
    expect(await zipped.invoke('xrCollector:desktop:chooseExportFile')).toEqual({ path: path.join(root, 'backup.ZIP'), overwrite: true });
    expect(await dialogs().invoke('xrCollector:desktop:chooseExportFile')).toBeNull();
    expect(await dialogs().invoke('xrCollector:desktop:chooseImportFile')).toBeNull();
  });

  it('reveals only the Vault and the finished export the runtime reports', async () => {
    const exported = { vaultPath: '/vault', operation: 'export', state: 'completed', result: { exportPath: '/exports/a.zip' } } as unknown as TransferStatus;
    const subject = dialogs({ status: exported });
    await subject.invoke('xrCollector:desktop:revealVault', '/somewhere/else');
    await subject.invoke('xrCollector:desktop:revealExport', '/somewhere/else.zip');
    expect(subject.revealed).toEqual(['/vault', '/exports/a.zip']);

    const running = dialogs({ status: { ...exported, state: 'running' } as TransferStatus });
    await running.invoke('xrCollector:desktop:revealExport');
    expect(running.revealed).toEqual([]);
    const closed = dialogs();
    await closed.invoke('xrCollector:desktop:revealVault');
    expect(closed.revealed).toEqual([]);
  });
});

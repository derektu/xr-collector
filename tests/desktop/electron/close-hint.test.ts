// Broken, Windows users are told more than once or never that closing the window leaves the App running, or macOS users are told needlessly.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CloseHintRecord, hintStillRunning, type StillRunningHint } from '../../../src/desktop/electron/close-hint.js';

function memoryRecord(shown = false) {
  let marked = shown;
  return { shown: async () => marked, markShown: vi.fn(async () => { marked = true; }) };
}

it('tells Windows users once that a closed window leaves the app running in the notification area, since there it otherwise looks like a quit; macOS keeps its Dock icon and is not told', async () => {
  const windowsRecord = memoryRecord();
  const windowsHints: StillRunningHint[] = [];
  await hintStillRunning({ platform: 'win32', record: windowsRecord, notify: (hint) => windowsHints.push(hint) });
  await hintStillRunning({ platform: 'win32', record: windowsRecord, notify: (hint) => windowsHints.push(hint) });
  expect(windowsHints).toHaveLength(1);

  const macRecord = memoryRecord();
  const macNotify = vi.fn();
  await hintStillRunning({ platform: 'darwin', record: macRecord, notify: macNotify });
  expect(macNotify).not.toHaveBeenCalled();
  expect(macRecord.markShown).not.toHaveBeenCalled();
});

it('counts a missing or unreadable close-hint record as not shown, so a broken file costs at most one extra hint', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = await mkdtemp(path.join(tmpdir(), 'xr-close-hint-'));
  const file = path.join(root, 'tray.json');
  const record = new CloseHintRecord(file);

  await expect(record.shown()).resolves.toBe(false);
  await writeFile(file, '{not json');
  await expect(record.shown()).resolves.toBe(false);
  await record.markShown();
  await expect(record.shown()).resolves.toBe(true);
  warn.mockRestore();
});

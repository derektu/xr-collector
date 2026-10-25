import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { temp } from './support.js';

const { recordElectronUiOrigin } = await import('../../../.claude/skills/verify/scripts/lib/electron.mjs');

describe('Electron run-private Agent metadata', () => {
  it('keeps only the current UI origin across relaunches and protects run.json on POSIX', () => {
    const runDir = temp('electron-agent-metadata');
    mkdirSync(runDir, { recursive: true });
    const record = { runDir };

    recordElectronUiOrigin(record, { url: () => 'http://127.0.0.1:7100/settings' });
    recordElectronUiOrigin(record, { url: () => 'http://127.0.0.1:7200/' });

    const file = path.join(runDir, 'run.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ runDir, uiUrl: 'http://127.0.0.1:7200' });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { openAgentConnection, type AgentListenerControl } from '../../../src/app/runtime/agent-connection.js';

vi.mock('node:crypto', async (original) => ({ ...await original<typeof import('node:crypto')>(), randomBytes: (size: number) => Buffer.alloc(size, 7) }));
const KEY = '07'.repeat(32);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-agent-connection-'));
  roots.push(root);
  return root;
}

const open = (settingsFile: string) => openAgentConnection({ settingsFile, preferredPort: 1, skillPath: 'skills/xr-collector-agent' });

describe('an Agent connection without settings', () => {
  it.each([
    ['cannot be read', async (root: string) => { const file = path.join(root, 'agent-settings.json'); await mkdir(file); return file; }],
    ['cannot be saved', async (root: string) => `${path.join(root, 'missing-parent')}${path.sep}`],
  ])('offers no listener and authorizes nothing when the settings %s', async (_case, settingsFile) => {
    const opened = await open(await settingsFile(await temp()));
    expectTypeOf(opened.access).not.toHaveProperty('attach');
    expectTypeOf(opened.listener).toEqualTypeOf<AgentListenerControl | null>();
    expect(opened.listener).toBeNull();
    for (const header of ['Bearer ', `Bearer ${KEY}`, undefined]) expect(opened.access.authorize(header)).toBe(false);
  });

  it('replaces a saved key that masking could not find in JSON, so the connection still starts', async () => {
    const settingsFile = path.join(await temp(), 'agent-settings.json');
    await writeFile(settingsFile, JSON.stringify({ schemaVersion: 1, token: 'quote"inside-key', port: { mode: 'auto' } }));
    const opened = await open(settingsFile);
    expect(opened.listener).not.toBeNull();
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).token).toBe(KEY);
  });

  it('offers the listener once the settings are saved', async () => {
    const opened = await open(path.join(await temp(), 'agent-settings.json'));
    expect(opened.listener?.candidatePorts()).toContain(1);
    expect(opened.access.authorize(`Bearer ${KEY}`)).toBe(true);
  });
});

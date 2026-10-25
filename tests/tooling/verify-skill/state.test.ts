// What `state` reads from a run's folders: the Vault's documents with frontmatter and content hash,
// its other files by format, the profile's records without Meilisearch's own files, and nothing
// written while reading. A run with no server reports `api` and `index` as unavailable. The
// Meilisearch master key is read from a real process's environment on macOS and Linux. The API of
// a stopped run is never read, even when another server answers on its port; document pages stop
// when nextOffset does not move forward; a folder that cannot be listed does not stop the reading.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState, masterKey, readState } from '../../../.claude/skills/verify/scripts/lib/state.mjs';
import { cleanUp, start, temp, until } from './support.js';

const VERIFY = path.resolve(import.meta.dirname, '../../../.claude/skills/verify/scripts/verify.mjs');

afterEach(cleanUp);

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Every file under `root` with its contents and modification time. */
function snapshot(root: string) {
  return (readdirSync(root, { recursive: true }) as string[]).sort().map((relative) => {
    const file = path.join(root, relative);
    const stat = statSync(file);
    return [relative, stat.mtimeMs, stat.isFile() ? readFileSync(file, 'utf8') : null];
  });
}

/** A stopped Web run: run.json naming a port nothing listens on, a profile and the Vault it selects. */
function stoppedRun() {
  const runDir = temp('state');
  const vault = path.join(runDir, 'vault');
  const profile = path.join(runDir, 'profile');
  write(path.join(runDir, 'run.json'), JSON.stringify({ kind: 'web', runDir, url: 'http://127.0.0.1:9', ports: { slot: 0 } }));
  write(path.join(vault, 'xr-collector-vault.json'), '{"format":"xr-collector-vault","formatVersion":1}');
  write(path.join(vault, 'settings', 'channels.json'), '{"subscriptions":[{"id":"A"}]}');
  write(path.join(vault, 'documents', 'kind', 'one.md'), '---\ntitle: 第一份\ncollector:\n  id: kind:one\n---\n正文一\n');
  write(path.join(vault, 'documents', 'kind', 'two.md'), '沒有 frontmatter 的文件\n');
  write(path.join(vault, 'notes.txt'), 'plain');
  write(path.join(vault, '.DS_Store'), 'finder');
  write(path.join(profile, 'vault-selection.json'), JSON.stringify({ path: vault }));
  write(path.join(profile, 'jobs', 'jobs.json'), '{"jobs":[{"id":"j1","state":"done"}]}');
  write(path.join(profile, 'jobs', 'events', '2026-10-23.jsonl'), '{"event":"queued"}\n{"event":"done"}\n');
  write(path.join(profile, 'broken.json'), '{"half":');
  write(path.join(profile, 'search-0123', 'data.mdb'), 'meilisearch');
  write(path.join(profile, 'search-0123.pid'), '{"pid":1}');
  return { runDir, vault, profile };
}

describe('readState', () => {
  it('reads the Vault and the profile by file format', async () => {
    const { runDir, vault, profile } = stoppedRun();

    const state = await readState(runDir);

    expect(state.running).toBe(false);
    expect(state.vault.path).toBe(vault);
    expect(state.vault.documents).toEqual([
      { path: 'documents/kind/one.md', bytes: expect.any(Number), frontmatter: { title: '第一份', collector: { id: 'kind:one' } }, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      { path: 'documents/kind/two.md', bytes: expect.any(Number), frontmatter: null, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    ]);
    expect(state.vault.files).toEqual({
      'settings/channels.json': { subscriptions: [{ id: 'A' }] },
      'xr-collector-vault.json': { format: 'xr-collector-vault', formatVersion: 1 },
    });
    expect(state.vault.other).toEqual([{ path: 'notes.txt', bytes: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }]);
    expect(state.profile.path).toBe(profile);
    expect(Object.keys(state.profile.files)).toEqual(['broken.json', 'jobs/events/2026-10-23.jsonl', 'jobs/jobs.json', 'vault-selection.json']);
    expect(state.profile.files['jobs/jobs.json']).toEqual({ jobs: [{ id: 'j1', state: 'done' }] });
    expect(state.profile.files['jobs/events/2026-10-23.jsonl']).toEqual([{ event: 'queued' }, { event: 'done' }]);
    expect(state.profile.files['broken.json']).toEqual({ error: expect.any(String) });
    expect(state.profile.other).toEqual([]);
  });

  it('hashes only the text after the frontmatter', async () => {
    const { runDir, vault } = stoppedRun();
    const before = (await readState(runDir)).vault.documents[0].contentHash;
    write(path.join(vault, 'documents', 'kind', 'one.md'), '---\ntitle: 改過的標題\n---\n正文一\n');
    const sameBody = (await readState(runDir)).vault.documents[0].contentHash;
    write(path.join(vault, 'documents', 'kind', 'one.md'), '---\ntitle: 改過的標題\n---\n正文二\n');
    const otherBody = (await readState(runDir)).vault.documents[0].contentHash;

    expect(sameBody).toBe(before);
    expect(otherBody).not.toBe(before);
  });

  it('writes nothing', async () => {
    const { runDir } = stoppedRun();
    const before = snapshot(runDir);
    await readState(runDir);
    expect(snapshot(runDir)).toEqual(before);
  });

  it('redacts persistent profile credentials from readState and CLI state output', async () => {
    const { runDir, profile } = stoppedRun();
    const token = 'persistent-agent-token-must-not-leak';
    write(path.join(profile, 'agent-settings.json'), JSON.stringify({
      schemaVersion: 1,
      token,
      port: { mode: 'fixed', port: 65431 },
    }));

    const state = await readState(runDir);
    expect(state.profile.files['agent-settings.json']).toEqual({
      schemaVersion: 1,
      token: { redacted: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      port: { mode: 'fixed', port: 65431 },
    });
    expect(JSON.stringify(state)).not.toContain(token);

    const cli = execFileSync(process.execPath, [VERIFY, 'state', '--run', runDir], { encoding: 'utf8' });
    expect(cli).not.toContain(token);
    expect(JSON.parse(cli).profile.files['agent-settings.json']).toEqual(state.profile.files['agent-settings.json']);
  });

  it('reports the API and the index as unavailable when the run is stopped', async () => {
    const { runDir } = stoppedRun();
    const state = await readState(runDir);
    expect(state.api).toEqual({ unavailable: expect.stringContaining('the run is not running') });
    expect(state.index).toEqual({ unavailable: expect.stringContaining('no Meilisearch process') });
  });

  it('does not read another run that answers on a stopped run\'s port', async () => {
    const { runDir } = stoppedRun();
    const requests: string[] = [];
    const other = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ documents: [], total: 0, nextOffset: null }));
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const { port } = other.address() as { port: number };
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ kind: 'web', runDir, url: `http://127.0.0.1:${port}`, ports: { slot: 0 } }));
    try {
      const state = await readState(runDir);
      expect(state.api).toEqual({ unavailable: expect.stringContaining('the run is not running') });
      expect(requests).toEqual([]);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it.skipIf(process.platform === 'win32')('records a folder it cannot list and reads the rest', async () => {
    const { runDir, vault } = stoppedRun();
    const locked = path.join(vault, 'documents', 'kind');
    chmodSync(locked, 0o000);
    try {
      const state = await readState(runDir);
      expect(state.vault.files['documents/kind/']).toEqual({ error: expect.stringContaining('EACCES') });
      expect(state.vault.documents).toEqual([]);
      expect(Object.keys(state.vault.files)).toContain('xr-collector-vault.json');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('reads the run folder Vault when the profile selects none', async () => {
    const { runDir, vault, profile } = stoppedRun();
    writeFileSync(path.join(profile, 'vault-selection.json'), '{}');
    expect((await readState(runDir)).vault.path).toBe(vault);
  });
});

describe('apiState documents', () => {
  /** An API whose document pages answer with `nextOffset` from `next(offset)`; it fails after 10 requests. */
  const api = (next: (offset: number) => unknown) => {
    let requests = 0;
    return {
      async api(pathname: string) {
        requests += 1;
        if (requests > 10) throw new Error('more than 10 requests');
        if (!pathname.startsWith('/api/documents')) return {};
        const offset = Number(new URL(pathname, 'http://x').searchParams.get('offset'));
        return { documents: [{ id: `doc-${offset}` }], total: 3, ...(next(offset) === undefined ? {} : { nextOffset: next(offset) }) };
      },
    };
  };

  it('reads every page until nextOffset is null', async () => {
    const { documents } = await apiState(api((offset) => (offset < 2 ? offset + 1 : null)));
    expect(documents).toEqual({ documents: [{ id: 'doc-0' }, { id: 'doc-1' }, { id: 'doc-2' }], total: 3, pages: 3 });
  });

  it('stops with an error when nextOffset is missing or does not move forward', async () => {
    const missing = (await apiState(api(() => undefined))).documents;
    const repeated = (await apiState(api((offset) => offset))).documents;
    expect(missing).toMatchObject({ pages: 1, error: expect.stringContaining('nextOffset did not advance') });
    expect(repeated).toMatchObject({ pages: 1, error: expect.stringContaining('nextOffset did not advance') });
  });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('masterKey', () => {
  it('reads MEILI_MASTER_KEY from a running process', async () => {
    const child = start(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env: { ...process.env, MEILI_MASTER_KEY: 'k3y-from-environment' } });
    await until(() => masterKey(child.pid!) !== null);
    expect(masterKey(child.pid!)).toBe('k3y-from-environment');
  });

  it('is null for a process without the key', () => {
    const env = { ...process.env };
    delete env.MEILI_MASTER_KEY;
    const child = start(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env });
    expect(masterKey(child.pid!)).toBeNull();
  });
});

describe('masterKey on Windows', () => {
  it('is null: Windows does not show another process its environment', () => {
    expect(masterKey(process.pid, { platform: 'win32' })).toBeNull();
  });
});

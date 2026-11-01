// The data state of one run, read from four sources side by side: the HTTP API the UI calls (`api`),
// the Vault directory (`vault`), the profile's records (`profile`) and the run's Meilisearch
// (`index`). The API is part of the program under test, so an assertion that data was really saved
// reads the files and the index directly. Reading is generic: files by their format, indexes by
// what Meilisearch lists, never by feature, so a new feature needs no change here. Nothing is
// written: no folder is created, Meilisearch gets GET requests only, and a run can be read while it
// runs or after it stopped with --keep. A source that cannot be read says why in `unavailable`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readRecord, runProcesses } from './instance.mjs';
import { programName } from './platform.mjs';

/** Operating-system files that say nothing about the app's data. */
const IGNORED = new Set(['.DS_Store', '.localized', 'Thumbs.db', 'desktop.ini']);
/** Meilisearch's own files in the profile (its database folder and PID file), read through `index`. */
const SEARCH_DATA = /^search(?:[-.]|$)/u;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The state a proof of API behaviour checks: what the same API the UI calls reports, every document page included. */
export async function apiState(instance) {
  const read = (pathname) => instance.api(pathname).catch((error) => ({ error: error.message }));
  return {
    vault: await read('/api/vault/status'),
    subscriptions: await read('/api/subscriptions'),
    jobs: await read('/api/jobs/overview'),
    documents: await allDocuments(read),
    search: await read('/api/search/status'),
  };
}

/**
 * Every page of /api/documents, as { documents, total, pages }; the failing page's error otherwise.
 * Reading goes on only while `nextOffset` moves forward, so an API that omits or repeats it ends
 * with { error } beside the pages read so far.
 */
async function allDocuments(read) {
  const documents = [];
  let offset = 0;
  let total = 0;
  let pages = 0;
  for (;;) {
    const page = await read(`/api/documents?limit=100&offset=${offset}`);
    if (page.error) return { ...page, pages };
    documents.push(...page.documents);
    total = page.total;
    pages += 1;
    if (page.nextOffset === null) return { documents, total, pages };
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) {
      return { documents, total, pages, error: `nextOffset did not advance: ${JSON.stringify(page.nextOffset)} after offset ${offset}` };
    }
    offset = page.nextOffset;
  }
}

/**
 * Reads the state of the run in `run` (its directory, or an instance): { runDir, takenAt, running,
 * api, vault, profile, index }. See the skill's "State" section for each source's shape.
 */
export async function readState(run) {
  const runDir = path.resolve(typeof run === 'string' ? run : run.runDir);
  const record = readRecord(runDir);
  if (!record) throw new Error(`No run.json in ${runDir}`);
  if (record.unreadable) throw new Error(`${runDir}/run.json cannot be read`);
  const processes = runProcesses(record);
  const profile = record.profile ?? path.join(runDir, 'profile');
  return {
    runDir, takenAt: new Date().toISOString(), running: processes.length > 0,
    api: await readApi(record, processes),
    vault: readFolder(vaultPath(runDir, profile)),
    profile: readFolder(profile, { skip: SEARCH_DATA, redact: redactProfileSecrets }),
    index: await readIndex(processes),
  };
}

/**
 * The API of the run's own server. A stopped run's port may already serve another run that took the
 * slot, so the API is read only while the run's server process is alive.
 */
async function readApi(record, processes) {
  if (!record.url) return { unavailable: 'this run has no HTTP API address (an Electron run is checked through its window)' };
  const server = processes.some((member) => !member.holder && programName(member.executable ?? member.command.split(' ')[0]) !== 'meilisearch');
  if (!server) return { unavailable: 'the run is not running: no server process of this run' };
  const healthy = await fetch(`${record.url}/api/health`).then((response) => response.ok, () => false);
  if (!healthy) return { unavailable: `${record.url} does not answer; the server is not running` };
  return apiState({
    async api(pathname) {
      const response = await fetch(`${record.url}${pathname}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`GET ${pathname} → ${response.status} ${JSON.stringify(body)}`);
      return body;
    },
  });
}

/** The Vault the profile selects (it follows a switch), or the run's own vault/ folder. */
function vaultPath(runDir, profile) {
  try {
    const selected = JSON.parse(readFileSync(path.join(profile, 'vault-selection.json'), 'utf8')).path;
    if (typeof selected === 'string') return selected;
  } catch { /* no selection: a fixed Vault or none */ }
  return path.join(runDir, 'vault');
}

/**
 * Every file under `root` by format, paths relative with `/`: Markdown in `documents` as { path,
 * bytes, frontmatter, contentHash } with the hash over the text after the frontmatter; `.json`
 * parsed and `.jsonl` parsed per line in `files`; anything else in `other` with its size and hash.
 * A file that is being rewritten or does not parse is recorded with its `error`, and a folder that
 * cannot be listed (removed or renamed meanwhile) with its `error` under `<folder>/`; the rest is
 * still read. Top-level entries whose name matches `skip` are left out.
 */
export function readFolder(root, { skip = null, redact = null } = {}) {
  if (!existsSync(root)) return { path: root, unavailable: `${root} does not exist` };
  const documents = [];
  const files = {};
  const other = [];
  for (const relative of listFiles(root, skip, files)) {
    const file = path.join(root, relative);
    try {
      if (relative.endsWith('.md')) documents.push(markdown(relative, readFileSync(file, 'utf8')));
      else if (relative.endsWith('.json')) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        files[relative] = redact ? redact(parsed) : parsed;
      } else if (relative.endsWith('.jsonl')) {
        const parsed = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
        files[relative] = redact ? redact(parsed) : parsed;
      }
      else {
        const data = readFileSync(file);
        other.push({ path: relative, bytes: data.length, sha256: sha256(data) });
      }
    } catch (error) {
      files[relative] = { error: error.message };
    }
  }
  return { path: root, documents, files, other };
}

/**
 * Profile state is diagnostic output and may be printed or saved as evidence. Keep non-secret
 * settings available for comparison, but replace credentials recursively with a stable hash so a
 * key rotation remains observable without copying a usable credential into the terminal or JSON.
 */
function redactProfileSecrets(value) {
  if (Array.isArray(value)) return value.map(redactProfileSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    secretField(key)
      ? { redacted: true, sha256: sha256(typeof child === 'string' ? child : JSON.stringify(child)) }
      : redactProfileSecrets(child),
  ]));
}

function secretField(key) {
  const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase();
  return normalized === 'key' || normalized.endsWith('apikey') || ['token', 'secret', 'password', 'credential', 'authorization']
    .some((suffix) => normalized.endsWith(suffix));
}

function markdown(relative, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  let frontmatter = null;
  if (match) {
    try { frontmatter = parseYaml(match[1]); } catch (error) { frontmatter = { error: error.message }; }
  }
  return { path: relative, bytes: Buffer.byteLength(text), frontmatter, contentHash: sha256(match ? text.slice(match[0].length) : text) };
}

/** Files under `root`, sorted; a folder that cannot be listed goes into `errors` as `<folder>/`. */
function listFiles(root, skip, errors) {
  const found = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      errors[`${relative}/`] = { error: error.message };
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || (relative === '' && skip?.test(entry.name))) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  walk('');
  return found.sort();
}

/**
 * The run's Meilisearch: { url, indexes: [{ uid, primaryKey, numberOfDocuments, isIndexing, keys }],
 * tasks: { enqueued, processing, failed } }. The runtime starts it with a random master key that
 * lives only in its environment, which macOS (`ps -E`) and Linux (`/proc/<pid>/environ`) show to the
 * same user; Windows does not, so the index is unavailable there.
 */
async function readIndex(processes) {
  const search = processes.find((member) => programName(member.executable ?? member.command.split(' ')[0]) === 'meilisearch');
  if (!search) return { unavailable: 'the run has no Meilisearch process; the run is stopped or search did not start' };
  const address = /--http-addr\s+(\S+)/u.exec(search.command)?.[1];
  const key = masterKey(search.pid);
  if (!address) return { unavailable: `Meilisearch (PID ${search.pid}) has no --http-addr on its command line` };
  if (!key) return { unavailable: `the master key of Meilisearch (PID ${search.pid}) cannot be read on ${process.platform}` };
  const url = `http://${address}`;
  const get = async (pathname) => {
    const response = await fetch(`${url}${pathname}`, { headers: { authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`GET ${pathname} → ${response.status} ${await response.text()}`);
    return response.json();
  };
  try {
    const indexes = [];
    for (const { uid, primaryKey } of (await get('/indexes?limit=1000')).results) {
      const stats = await get(`/indexes/${encodeURIComponent(uid)}/stats`);
      indexes.push({ uid, primaryKey, numberOfDocuments: stats.numberOfDocuments, isIndexing: stats.isIndexing, keys: await indexKeys(get, uid, primaryKey) });
    }
    const tasks = {};
    for (const status of ['enqueued', 'processing', 'failed']) tasks[status] = (await get(`/tasks?statuses=${status}&limit=1`)).total;
    return { url, indexes, tasks };
  } catch (error) {
    return { url, unavailable: error.message };
  }
}

/** The primary key of every document in one index, sorted. */
async function indexKeys(get, uid, primaryKey) {
  if (!primaryKey) return [];
  const keys = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await get(`/indexes/${encodeURIComponent(uid)}/documents?fields=${encodeURIComponent(primaryKey)}&limit=1000&offset=${offset}`);
    keys.push(...page.results.map((document) => document[primaryKey]));
    if (offset + page.results.length >= page.total) break;
  }
  return keys.sort();
}

/** MEILI_MASTER_KEY from a process's environment; null where the platform does not show it. */
export function masterKey(pid, { platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((entry) => entry.startsWith('MEILI_MASTER_KEY='))?.slice('MEILI_MASTER_KEY='.length) ?? null;
    }
    if (platform === 'darwin') {
      return /(?:^|\s)MEILI_MASTER_KEY=(\S+)/u.exec(execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }))?.[1] ?? null;
    }
  } catch { /* the process ended */ }
  return null;
}

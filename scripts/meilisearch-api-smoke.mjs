#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileSha256, inspectExecutable } from './build-meilisearch.mjs';
import { probePhysicalHost } from './physical-host.mjs';
import { expectedOfficialManifest, readRuntimePins } from './prepare-meilisearch.mjs';

const options = parseArguments(process.argv.slice(2));
if (!options.binary) throw new Error('Usage: node scripts/meilisearch-api-smoke.mjs --binary <path> [--manifest <path>] [--require-native]');
const binary = path.resolve(options.binary);
const manifestPath = path.resolve(options.manifest ?? path.join(path.dirname(binary), 'meilisearch-build.json'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const bytes = await readFile(binary);
const inspected = inspectExecutable(bytes);
if (await fileSha256(binary) !== manifest.binary?.sha256 || bytes.length !== manifest.binary?.bytes
  || inspected.arch !== manifest.binary?.arch || manifest.binary?.version !== '1.53.2') {
  throw new Error('Smoke binary does not match its build manifest.');
}
if (manifest.distribution === 'official') {
  const expected = expectedOfficialManifest(await readRuntimePins(), manifest.target);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('Smoke official manifest does not match the pinned release asset.');
}
if (options.requireNative) {
  const expected = manifest.target === 'darwin-arm64' ? ['darwin', 'arm64']
    : manifest.target === 'darwin-x64' ? ['darwin', 'x64']
      : manifest.target === 'win32-x64' ? ['win32', 'x64'] : [];
  const host = await probePhysicalHost();
  const producerMatches = manifest.distribution === 'official'
    || (manifest.runner?.platform === host.platform && manifest.runner?.processArch === host.processArch
      && manifest.runner?.hostArch === host.hostArch && manifest.runner?.emulated === false);
  if (host.platform !== expected[0] || host.processArch !== expected[1] || host.hostArch !== expected[1]
    || host.emulated || !producerMatches) {
    throw new Error(`Native smoke for ${manifest.target} cannot run on ${host.platform}/${host.processArch} physical ${host.hostArch}.`);
  }
}

const database = await mkdtemp(path.join(tmpdir(), 'xr-meili-native-smoke-'));
const port = await availablePort();
const key = randomBytes(32).toString('hex');
let engine;
try {
  engine = await start(binary, database, port, key);
  const baseUrl = `http://127.0.0.1:${port}`;
  const version = await request(baseUrl, key, '/version');
  if (version.pkgVersion !== '1.53.2') throw new Error(`Smoke engine version is ${version.pkgVersion ?? 'unknown'}, expected 1.53.2.`);
  const index = await request(baseUrl, key, '/indexes', { method: 'POST', body: JSON.stringify({ uid: 'documents_v2', primaryKey: 'key' }) });
  await task(baseUrl, key, index.taskUid);
  const settings = {
    searchableAttributes: ['title', 'publisherName', 'bodyMarkdown'],
    filterableAttributes: ['id', 'sourceType', 'publisherId', 'publishedAtEpoch'],
    pagination: { maxTotalHits: 10_000 },
  };
  const settingTask = await request(baseUrl, key, '/indexes/documents_v2/settings', { method: 'PATCH', body: JSON.stringify(settings) });
  await task(baseUrl, key, settingTask.taskUid);
  const actualSettings = await request(baseUrl, key, '/indexes/documents_v2/settings');
  for (const [name, value] of Object.entries(settings)) if (JSON.stringify(actualSettings[name]) !== JSON.stringify(value)) throw new Error(`Canonical setting ${name} differs.`);
  if (actualSettings.localizedAttributes !== null) throw new Error('localizedAttributes must remain unset.');
  const documents = [
    { key: 'one', id: 'youtube:one', type: 'Transcript', sourceType: 'youtube', sourceId: 'one', sourceUrl: 'https://example.invalid/one', title: '台積電 AI 晶片', publisherId: 'channel-a', publisherName: '中文頻道', publishedAt: '2026-01-01T00:00:00.000Z', publishedAtEpoch: 1767225600000, collectedAt: '2026-01-02T00:00:00.000Z', youtube: { languageCode: 'zh-Hant' }, bodyMarkdown: `${'前言內容'.repeat(80)}台積電正在開發人工智慧晶片與先進製程。${'後續內容'.repeat(80)}`, contentHash: 'one' },
    { key: 'two', id: 'rss:two', type: 'Article', sourceType: 'rss', sourceId: 'two', sourceUrl: 'https://example.invalid/two', title: 'Semiconductor outlook', publisherId: 'feed-b', publisherName: 'English Feed', publishedAt: '2026-01-02T00:00:00.000Z', publishedAtEpoch: 1767312000000, collectedAt: '2026-01-03T00:00:00.000Z', rss: {}, bodyMarkdown: 'AI semiconductor demand and foundry capacity.', contentHash: 'two' },
    { key: 'three', id: 'youtube:three', type: 'Transcript', sourceType: 'youtube', sourceId: 'three', sourceUrl: 'https://example.invalid/three', title: '台積電供應鏈', publisherId: 'channel-c', publisherName: '產業頻道', publishedAt: '2026-01-03T00:00:00.000Z', publishedAtEpoch: 1767398400000, collectedAt: '2026-01-04T00:00:00.000Z', youtube: { languageCode: 'zh-Hant' }, bodyMarkdown: `${'市場消息'.repeat(80)}台積電供應鏈追蹤。${'產業分析'.repeat(80)}`, contentHash: 'three' },
  ];
  const add = await request(baseUrl, key, '/indexes/documents_v2/documents', { method: 'PUT', body: JSON.stringify(documents) });
  await task(baseUrl, key, add.taskUid);
  const searchPayload = {
    q: '台積電', hitsPerPage: 1, page: 1,
    attributesToRetrieve: ['id', 'type', 'sourceType', 'sourceId', 'sourceUrl', 'title', 'publisherId', 'publisherName', 'publishedAt', 'collectedAt', 'youtube', 'rss', 'bodyMarkdown'],
    attributesToCrop: ['bodyMarkdown:32'], attributesToHighlight: ['bodyMarkdown'],
    highlightPreTag: '<mark>', highlightPostTag: '</mark>', cropMarker: '…', matchingStrategy: 'all',
    filter: ['sourceType = "youtube"'],
  };
  const first = await request(baseUrl, key, '/indexes/documents_v2/search', { method: 'POST', body: JSON.stringify(searchPayload) });
  const second = await request(baseUrl, key, '/indexes/documents_v2/search', { method: 'POST', body: JSON.stringify({ ...searchPayload, page: 2 }) });
  const englishPayload = { ...searchPayload, q: 'AI semiconductor', page: 1, hitsPerPage: 10, filter: ['sourceType = "rss"'] };
  const english = await request(baseUrl, key, '/indexes/documents_v2/search', { method: 'POST', body: JSON.stringify(englishPayload) });
  const youtubeOnly = await request(baseUrl, key, '/indexes/documents_v2/search', { method: 'POST', body: JSON.stringify({ ...searchPayload, q: '', page: 1, hitsPerPage: 10, filter: ['sourceType = "youtube"'] }) });
  const rssOnly = await request(baseUrl, key, '/indexes/documents_v2/search', { method: 'POST', body: JSON.stringify({ ...searchPayload, q: '', page: 1, hitsPerPage: 10, filter: ['sourceType = "rss"'] }) });
  if (first.totalHits !== 2 || first.hits.length !== 1 || second.hits.length !== 1 || first.hits[0].id === second.hits[0].id
    || !first.hits[0]._formatted?.bodyMarkdown?.includes('<mark>') || !first.hits[0]._formatted.bodyMarkdown.includes('…')) throw new Error('Query/filter/page/highlight/crop smoke failed.');
  if (english.totalHits !== 1 || english.hits[0]?.id !== 'rss:two') throw new Error('English RSS query smoke failed.');
  if (youtubeOnly.totalHits !== 2 || JSON.stringify(youtubeOnly.hits.map(({ id }) => id).sort()) !== JSON.stringify(['youtube:one', 'youtube:three'])
    || rssOnly.totalHits !== 1 || rssOnly.hits[0]?.id !== 'rss:two') throw new Error('Source filter counterfactual smoke failed.');
  await stop(engine);
  engine = await start(binary, database, port, key);
  const restartedStats = await request(baseUrl, key, '/indexes/documents_v2/stats');
  const restartedSearch = await request(baseUrl, key, '/indexes/documents_v2/search', { method: 'POST', body: JSON.stringify(searchPayload) });
  const restartedEnglish = await request(baseUrl, key, '/indexes/documents_v2/search', { method: 'POST', body: JSON.stringify(englishPayload) });
  if (restartedStats.numberOfDocuments !== 3 || restartedSearch.totalHits !== 2
    || restartedEnglish.totalHits !== 1 || restartedEnglish.hits[0]?.id !== 'rss:two') throw new Error('Restart persistence smoke failed.');
  console.log(JSON.stringify({ status: 'pass', target: manifest.target, sha256: manifest.binary.sha256, documents: 3, totalHits: restartedSearch.totalHits }));
} finally {
  if (engine) await stop(engine);
  await rm(database, { recursive: true, force: true });
}

async function start(executable, databasePath, portNumber, apiKey) {
  const child = spawn(executable, ['--db-path', databasePath, '--http-addr', `127.0.0.1:${portNumber}`, '--env', 'production', '--no-analytics'], {
    env: { ...process.env, MEILI_MASTER_KEY: apiKey }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Meilisearch exited during smoke: ${stderr}`);
    try { if ((await fetch(`http://127.0.0.1:${portNumber}/health`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1000) })).ok) return child; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`Meilisearch health timeout: ${stderr}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Meilisearch smoke stop timeout')), 10_000))]);
}

async function request(baseUrl, apiKey, endpoint, init = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, { ...init, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function task(baseUrl, apiKey, uid) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, apiKey, `/tasks/${uid}`);
    if (result.status === 'succeeded') return;
    if (result.status === 'failed' || result.status === 'canceled') throw new Error(`Task ${uid} ${result.status}: ${result.error?.message ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Task ${uid} timed out.`);
}

async function availablePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Unable to allocate smoke port.')); return; }
      const selected = address.port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--binary') parsed.binary = argv[++index];
    else if (argv[index] === '--manifest') parsed.manifest = argv[++index];
    else if (argv[index] === '--require-native') parsed.requireNative = true;
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  return parsed;
}

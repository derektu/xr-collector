// The collector runtime one verification run drives: the checkout's own CollectorRuntime, serving the
// Web UI built for this run, with an isolated profile, Vault and export/backup folders on the slot's ports.
//
// Data modes (XR_VERIFY_DATA):
//   synthetic  YouTube goes through synthetic channels read from <run>/catalog.json in place of yt-dlp;
//              RSS is the real plugin reading the synthetic feeds this process serves on the feeds port.
//   real       the product's plugins as the development server assembles them: yt-dlp, Deno, live feeds.
//
// Synthetic catalog (<run>/catalog.json, read again on every request so a flow edits it between steps):
//   youtube.channels[]   { id, handle, title, videos: [{ id, title, publishedAt }] }, videos newest first
//   youtube.failListing  channel ID whose listing fails with network_error
//   youtube.failVideo    video ID whose capture fails with video_unavailable
//   youtube.rateLimitNext  true makes the next capture fail with rate_limited, then clears itself
//   feeds["/path"]       { kind: 'rss2' | 'atom' | 'page', title, articles?, feeds?, status?, delayMs? }
//                        or { status, body, contentType } for a literal answer
//   network              'offline' cuts the device off: synthetic YouTube requests fail with network_error,
//                        and the feeds port, which also answers the runtime's network probe at /connectivity,
//                        drops every connection. 'online' or absent restores it.
// Synthetic titles carry 【合成】 so a screenshot never passes for a real source.
//
// Environment: XR_VERIFY_CHECKOUT, XR_VERIFY_RUN, XR_VERIFY_DATA, XR_VERIFY_VAULT_MODE (selected | fixed | none),
// XR_VERIFY_UI_PORT, XR_VERIFY_SEARCH_PORT, XR_VERIFY_AGENT_PORT, XR_VERIFY_FEEDS_PORT.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(process.env.XR_VERIFY_CHECKOUT!);
const run = path.resolve(process.env.XR_VERIFY_RUN!);
const data = process.env.XR_VERIFY_DATA ?? 'synthetic';
const vaultMode = process.env.XR_VERIFY_VAULT_MODE ?? 'selected';
const port = (name: string) => Number(process.env[`XR_VERIFY_${name}_PORT`]);
const load = (relative: string) => import(pathToFileURL(path.join(checkout, relative)).href);

const { createSourcePlugins, registerSources } = await load('src/plugins/index.ts');
const { CollectorError } = await load('src/core/types.ts');
const { publishedSince } = await load('src/core/published.ts');
const { CollectorRuntime } = await load('src/runtime/collector-runtime.ts');
const { PacingGate } = await load('src/pacing/pacing-gate.ts');
const { youtubeSource } = await load('src/plugins/youtube/adapter.ts');
const { youtubePlugin, YOUTUBE_PACING } = await load('src/plugins/youtube/server.ts');
const { createRssPlugin, rssDefinition } = await load('src/plugins/rss/server.ts');
const { createVaultDirectory } = await load('src/vault/vault-directory.ts');
const { VaultSelection } = await load('src/vault/vault-selection.ts');
const { exportFolder, backupFolder } = await load('src/vault/transfer-files.ts');
const { rss2, atom, page } = await load('tests/support/synthetic-feeds.ts');
// A reverse-baseline run uses an older checkout that has no updater modules. Keep its server
// runnable without copying new product source into it: the flow then fails meaningfully on the
// absent device update API instead of failing verification-server provisioning.
const updateModulesAvailable = existsSync(path.join(checkout, 'src/updates/update-service.ts'))
  && existsSync(path.join(checkout, 'src/updates/sources.ts'));
const updateServiceModule = updateModulesAvailable ? await load('src/updates/update-service.ts') : null;
const updateSourcesModule = updateModulesAvailable ? await load('src/updates/sources.ts') : null;
const UpdateService = updateServiceModule?.UpdateService;
const GenericIndexSource = updateSourcesModule?.GenericIndexSource;

const profilePath = path.join(run, 'profile');
const vaultPath = path.join(run, 'vault');
const catalogPath = path.join(run, 'catalog.json');
const loginStartupFixturePath = path.join(run, 'login-startup-fixture.json');
const scheduleTriggerPath = path.join(run, 'schedule-trigger');
const catalog = () => JSON.parse(readFileSync(catalogPath, 'utf8'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const offline = () => catalog().network === 'offline';
const cutOff = () => { if (offline()) throw new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。（合成斷網）'); };
const createdBy = `XR Collector (verify skill, ${data} data)`;
const program = (name: string, environmentName: string) => process.env[environmentName]
  ?? path.join(checkout, 'resources', 'bin', 'mac', name);

// Opt-in fixture for the recorded update flow. It serves the real generic-index protocol and runs
// the real UpdateService, but validates a semantic test file instead of pretending Web mode can
// install a native app. Other verification runs do not receive an update source or fake installer.
const updateEnabled = () => updateModulesAvailable && data === 'synthetic' && catalog().updates?.enabled === true;
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const fixtureBuildInfo = Object.freeze({ schemaVersion: 1, kind: 'development', version: '0.1.0', builtAt: '2026-10-27T00:00:00.000Z',
  commit: '1'.repeat(40), buildId: 'verify-update-0.1.0', target: 'darwin-arm64', sourceDirty: false });
const updateFixture = (version = String(catalog().updates?.version ?? '0.1.1')) => {
  const prefix = Buffer.from(`XR-COLLECTOR-VERIFY-UPDATE-${version}\n`);
  const payload = Buffer.concat([prefix, Buffer.alloc(100_000 - prefix.byteLength, version.endsWith('.2') ? 0x37 : 0x36)]);
  const payloadName = `XR-Collector-${version}-mac-arm64.zip`;
  const commit = '2'.repeat(40);
  const buildInfo = { ...fixtureBuildInfo, kind: 'packaged', version, commit, buildId: `verify-update-${version}` };
  const payloadFile = { name: payloadName, bytes: payload.byteLength, sha256: sha256(payload) };
  const indexBody = Buffer.from(JSON.stringify({ schemaVersion: 1, version, commit, target: 'darwin-arm64', buildInfo,
    installer: payloadFile, update: payloadFile }));
  const notesBody = Buffer.from(`## 驗證版 ${version}\n\n- 合成更新，只驗證共用下載與等待流程。`);
  return { version, payload, payloadName, indexBody, notesBody };
};

type LoginStartupFixture = {
  mode: 'unavailable' | 'normal' | 'failure' | 'requires_approval';
  enabled: boolean;
};
if (!existsSync(loginStartupFixturePath)) writeFileSync(loginStartupFixturePath, JSON.stringify({ mode: 'unavailable', enabled: false }, null, 2));
const readLoginStartup = (): LoginStartupFixture => JSON.parse(readFileSync(loginStartupFixturePath, 'utf8'));
const loginStartupStatus = (fixture = readLoginStartup()) => {
  if (fixture.mode === 'unavailable') return {
    supported: false, enabled: false, state: 'unavailable' as const,
    message: '登入自啟只可在已安裝的 macOS 或 Windows App 中設定。',
  };
  if (fixture.mode === 'requires_approval') return {
    supported: true, enabled: false, state: 'requires_approval' as const,
    message: '請到「系統設定 → 一般 → 登入項目與延伸功能」允許 XR Collector。',
  };
  return {
    supported: true, enabled: fixture.enabled, state: fixture.enabled ? 'enabled' as const : 'disabled' as const,
    message: fixture.enabled ? '已在登入電腦時自動啟動。' : '登入自啟已關閉。',
  };
};
// Verification-only platform fixture. The product receives only the normal LoginStartupAccess seam;
// flows mutate this run-local file to model OS read-back, never through a product API.
const loginStartup = {
  status: async () => loginStartupStatus(),
  update: async (enabled: boolean) => {
    const fixture = readLoginStartup();
    if (fixture.mode === 'unavailable') throw new CollectorError('login_startup_unavailable', loginStartupStatus().message);
    if (fixture.mode === 'requires_approval') throw new CollectorError('login_startup_requires_approval', loginStartupStatus().message);
    if (fixture.mode === 'failure') throw new CollectorError('login_startup_failed', '合成作業系統拒絕更新登入自啟。');
    writeFileSync(loginStartupFixturePath, JSON.stringify({ mode: 'normal', enabled }, null, 2));
    return loginStartupStatus();
  },
};

function syntheticFeedServer() {
  const server = createServer((request, response) => {
    if (offline()) { request.socket.destroy(); return; }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/connectivity') { response.writeHead(204).end(); return; }
    if (updateEnabled() && pathname === '/updates/release-darwin-arm64.json') {
      const { indexBody } = updateFixture();
      const status = Number(catalog().updates.indexStatus ?? 200);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': status === 200 ? indexBody.byteLength : 0 }).end(status === 200 ? indexBody : undefined); return;
    }
    const fixture = updateEnabled() ? updateFixture() : null;
    if (fixture && pathname === '/updates/release-notes.md') {
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-length': fixture.notesBody.byteLength }).end(fixture.notesBody); return;
    }
    if (fixture && pathname === `/updates/${fixture.payloadName}`) {
      const settings = catalog().updates;
      const body = settings.payloadMode === 'corrupt' ? Buffer.from(fixture.payload) : fixture.payload;
      if (settings.payloadMode === 'corrupt') body[body.length - 1] ^= 0xff;
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.byteLength });
      const delay = Number(settings.payloadDelayMs ?? 0);
      if (!delay) { response.end(body); return; }
      const first = Math.floor(body.byteLength * 0.62);
      response.write(body.subarray(0, first));
      setTimeout(() => { if (!response.destroyed) response.end(body.subarray(first)); }, delay);
      return;
    }
    const route = catalog().feeds?.[pathname];
    const answer = () => {
      if (!route) { response.writeHead(404).end('not found'); return; }
      const body = route.kind === 'rss2' ? rss2(route.title, revive(route.articles))
        : route.kind === 'atom' ? atom(route.title, revive(route.articles), route.base)
          : route.kind === 'page' ? page(route.title, route.feeds ?? [])
            : route.body;
      const type = route.contentType ?? (route.kind === 'page' ? 'text/html; charset=utf-8' : 'application/rss+xml; charset=utf-8');
      response.writeHead(route.status ?? 200, { 'content-type': type }).end(body);
    };
    if (route?.delayMs) setTimeout(answer, route.delayMs);
    else answer();
  });
  // Feed builders take Date values; the catalog stores ISO strings.
  const revive = (articles: Array<Record<string, unknown>> = []) => articles.map((article) => ({
    ...article, publishedAt: article.publishedAt ? new Date(String(article.publishedAt)) : null,
  }));
  return new Promise<typeof server>((resolve) => server.listen(port('FEEDS'), '127.0.0.1', () => resolve(server)));
}

async function syntheticSources() {
  const fast = { statePath: null, waitRangeMs: { min: 100, max: 250 } };
  const youtubeGate = await PacingGate.open(YOUTUBE_PACING, { ...fast, cooldown: { initialMs: 30_000, maxMs: 30_000 } });
  const rssGate = await PacingGate.open(rssDefinition.pacing, fast);
  const gates = new Map([[youtubeGate.group, youtubeGate], [rssGate.group, rssGate]]);
  const youtube = () => catalog().youtube ?? { channels: [] };

  const channels = {
    resolve: (inputUrl: string, options: { priority?: string; signal?: AbortSignal } = {}) =>
      youtubeGate.run(options.priority ?? 'interactive', async () => {
        await sleep(400);
        cutOff();
        const url = new URL(inputUrl.startsWith('@') ? `https://www.youtube.com/${inputUrl}` : inputUrl);
        const parts = url.pathname.split('/').filter(Boolean);
        const found = youtube().channels.find((channel: { id: string; handle: string }) =>
          parts[0] === `@${channel.handle}` || (parts[0] === 'channel' && parts[1] === channel.id));
        if (!found) throw new CollectorError('invalid_subscription', '無法辨認這個 YouTube 頻道。');
        return { id: found.id, title: found.title, url: `https://www.youtube.com/channel/${found.id}/videos` };
      }, options.signal),
    listVideos: (channel: { id: string }, listing: { offset: number; limit: number }, options: { priority?: string; signal?: AbortSignal } = {}) =>
      youtubeGate.run(options.priority ?? 'background', async () => {
        await sleep(200);
        cutOff();
        const current = youtube();
        if (current.failListing === channel.id) throw new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。（合成錯誤）');
        const videos = current.channels.find((candidate: { id: string }) => candidate.id === channel.id)?.videos ?? [];
        return videos.slice(listing.offset, listing.offset + listing.limit).map((video: { id: string; title: string; publishedAt: string }) => ({
          id: video.id, title: video.title, url: `https://www.youtube.com/watch?v=${video.id}`, publishedAt: video.publishedAt, upcoming: false,
        }));
      }, options.signal),
  };
  const capture = {
    capture: (video: { videoId: string; canonicalUrl: string }, options: { publishedNotBefore?: string; signal?: AbortSignal } = {}) =>
      youtubeGate.run('background', async () => {
        cutOff();
        const current = catalog();
        if (current.youtube?.rateLimitNext) {
          writeFileSync(catalogPath, JSON.stringify({ ...current, youtube: { ...current.youtube, rateLimitNext: false } }, null, 2));
          throw new CollectorError('rate_limited', 'YouTube 暫時限制連線。（合成冷卻）');
        }
        const owner = youtube().channels.find((channel: { videos: Array<{ id: string }> }) => channel.videos.some((candidate) => candidate.id === video.videoId));
        const found = owner?.videos.find((candidate: { id: string }) => candidate.id === video.videoId);
        if (!owner || !found || current.youtube?.failVideo === video.videoId) throw new CollectorError('video_unavailable', '這支影片無法收集。（合成錯誤）');
        if (options.publishedNotBefore && !publishedSince(found.publishedAt, options.publishedNotBefore)) {
          throw new CollectorError('out_of_range', '這支影片的發布時間早於收集範圍。');
        }
        await sleep(Number(current.youtube?.captureDelayMs ?? 600));
        // The network can drop while a capture is under way.
        cutOff();
        return {
          videoId: video.videoId, sourceUrl: video.canonicalUrl, title: found.title, channelId: owner.id, channelTitle: owner.title,
          publishedAt: found.publishedAt, languageCode: 'zh-Hant', languageName: '中文（合成）', subtitleKind: 'manual',
          bodyMarkdown: found.body ?? `【合成字幕】${found.title}。這是驗證用的合成內容，不是真實影片。\n\n## 第二段\n\n合成段落，用來檢查閱讀頁排版。`,
        };
      }, options.signal),
  };
  registerSources();
  const rss = createRssPlugin({
    profilePath, env: process.env, program,
    gate: (group: string) => gates.get(group)!,
  });
  return { plugins: [youtubePlugin(youtubeSource(capture, channels)), rss], pacing: [...gates.values()] };
}

const feeds = data === 'synthetic' ? await syntheticFeedServer() : null;
const sources = data === 'synthetic'
  ? await syntheticSources()
  : await createSourcePlugins({ profilePath, env: process.env, program });
const updateService = updateEnabled() ? await UpdateService.open({
  identity: { version: fixtureBuildInfo.version, target: fixtureBuildInfo.target },
  currentBuildId: fixtureBuildInfo.buildId,
  source: new GenericIndexSource(`http://127.0.0.1:${port('FEEDS')}/updates/`),
  installer: {
    available: true,
    validate: async (_offer: unknown, packageFile: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason;
      const expected = updateFixture((_offer as { version: string }).version).payload;
      if (!readFileSync(packageFile).equals(expected)) throw new CollectorError('update_integrity_failed', '合成更新檔內容不正確。');
    },
    prepare: async () => { throw new CollectorError('update_install_unavailable', 'Web 驗證不會安裝原生 App。'); },
  },
  directory: path.join(profilePath, 'updates'),
  // Leave a real apply request in waiting until the flow cancels it. This verifies the common
  // service/API/UI contract without claiming that a Web run can hand off to a native installer.
  apply: () => undefined,
}) : null;

// `selected` opens the Vault the way a user's chosen one opens, so moving it and opening another stay
// available; `fixed` is the XR_COLLECTOR_VAULT path, where the location cannot change. The Vault is
// created on the run's first start only; a restart finds the profile's vault-selection.json and opens
// whatever Vault it names, as the app does after the user moved or switched it.
const selectionFile = path.join(profilePath, 'vault-selection.json');
if (vaultMode === 'selected' && !existsSync(selectionFile)) {
  await createVaultDirectory(vaultPath, createdBy);
  await new VaultSelection(selectionFile).write(vaultPath);
}
// Synthetic data confirms the network against the feeds port, so `network: 'offline'` in the catalog
// reads as a lost network; an offline device is confirmed again every 2 s instead of 30 s.
const syntheticConnectivity = {
  probe: (signal: AbortSignal) => fetch(`http://127.0.0.1:${port('FEEDS')}/connectivity`, { signal, cache: 'no-store' })
    .then((response) => response.status === 204, () => false),
  offlineRecheckMs: 2_000,
};
const runtime = await CollectorRuntime.start({
  profilePath,
  ...(updateService ? { buildInfo: fixtureBuildInfo, updates: updateService } : {}),
  ...(data === 'synthetic' ? { connectivity: syntheticConnectivity } : {}),
  workspace: {
    plugins: sources.plugins,
    pacing: sources.pacing,
    searchBinary: program('meilisearch', 'XR_COLLECTOR_MEILISEARCH'),
    searchData: path.join(profilePath, 'search'),
    searchPort: port('SEARCH'),
    // The product's folder names under the run, as the app puts them under ~/Documents.
    exportFolder: exportFolder(path.join(run, 'documents')),
    backupFolder: backupFolder(path.join(run, 'documents')),
    // Keep retry state transitions but make synthetic failures settle promptly. Production uses the
    // normal 30 s / 120 s delays; this option already exists for controlled runtimes and tests.
    ...(data === 'synthetic' ? { jobRetry: { maxAttempts: 3, delaysMs: [2_000, 3_000] } } : {}),
  },
  ...(vaultMode === 'fixed' ? { explicitVaultPath: vaultPath } : {}),
  // Onboarding suggests this folder; inside the run, so accepting the suggestion stays isolated.
  suggestedVaultPath: vaultPath,
  createdBy,
  agentSettingsFile: path.join(profilePath, 'agent-settings.json'),
  skillPath: path.join(checkout, 'skills', 'xr-collector-agent'),
  agentPort: port('AGENT'),
  uiPort: port('UI'),
  webRoot: path.join(run, 'web'),
  loginStartup,
});
// A flow can move nextCheckAt into the past and touch this run-local file to request one scheduler
// poll immediately. This keeps scheduled-trigger semantics while avoiding a 15-second wall-clock
// wait per fixture. It belongs to the verify server, so product runtimes keep their normal timer.
let scheduleTrigger = '';
const scheduleTriggerTimer = data === 'synthetic' ? setInterval(() => {
  if (!existsSync(scheduleTriggerPath)) return;
  const value = readFileSync(scheduleTriggerPath, 'utf8');
  if (value === scheduleTrigger) return;
  scheduleTrigger = value;
  const schedule = runtime.workspace?.schedule as unknown as { checkNow(): Promise<void> } | undefined;
  // `schedule-trigger.done` names the last trigger whose poll has finished, so a flow waits for
  // the poll itself instead of a fixed time.
  void schedule?.checkNow()
    .then(() => writeFileSync(`${scheduleTriggerPath}.done`, value))
    .catch((error) => console.error('verify schedule trigger failed', error));
}, 50) : null;
console.log(`verify server ready at ${runtime.server.url} (${data} data, Vault ${vaultMode})`);
logFailedRequests(runtime.server.app.server);

// The product's HTTP app runs without a logger, so server.log records each answer with status 400
// or above: method, path, status and the code and message of its { error } body. Watching the
// underlying Node server leaves the app itself untouched.
function logFailedRequests(server: import('node:http').Server): void {
  server.prependListener('request', (request, response) => {
    const chunks: Buffer[] = [];
    const end = response.end.bind(response) as (...args: unknown[]) => typeof response;
    response.end = ((...args: unknown[]) => {
      if (response.statusCode >= 400 && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))) chunks.push(Buffer.from(args[0]));
      return end(...args);
    }) as typeof response.end;
    response.on('finish', () => {
      if (response.statusCode < 400) return;
      let error: { code?: string; message?: string } | undefined;
      try { error = JSON.parse(Buffer.concat(chunks).toString('utf8')).error; } catch { /* not JSON */ }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      console.error(`[${new Date().toISOString()}] ${request.method} ${pathname} → ${response.statusCode} ${error?.code ?? '-'}${error?.message ? ` ${error.message}` : ''}`);
    });
  });
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (scheduleTriggerTimer) clearInterval(scheduleTriggerTimer);
  try {
    await updateService?.close();
    await runtime.close();
    feeds?.closeAllConnections();
    feeds?.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

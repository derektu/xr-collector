// A collector process for the restart test: it saves one video, holds a second mid-capture and waits to be killed.
// Arguments: <profile directory> <Vault directory>.
import { watch } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { startCollectorServer } from '../../../../src/transport/server/collector-server.js';
import { UnavailableTranscriptSearch } from '../../../../src/domain/search/managed-transcript-search.js';
import { withYouTube } from '../../../support/youtube-sources.js';
import { PRODUCT_SOURCES } from '../../../support/product-sources.js';

const [profilePath, vaultPath] = process.argv.slice(2) as [string, string];
let holding!: () => void;
const held = new Promise<void>((resolve) => { holding = resolve; });

const runtime = await startCollectorServer({
  sources: PRODUCT_SOURCES,
  profilePath,
  explicitVaultPath: vaultPath,
  workspace: withYouTube({
    capture: {
      async capture(video: { videoId: string; canonicalUrl: string }) {
        if (video.videoId === 'killheld001') {
          holding();
          await new Promise<never>(() => undefined);
        }
        return {
          videoId: video.videoId, sourceUrl: video.canonicalUrl, title: `Video ${video.videoId}`, channelId: null,
          channelTitle: 'Runtime', publishedAt: null, languageCode: 'en', languageName: 'English',
          subtitleKind: 'manual' as const, bodyMarkdown: 'Body.',
        };
      },
    },
    channelSource: {
      resolve: async () => ({ id: 'UC-runtime', title: 'Runtime', url: 'https://www.youtube.com/channel/UC-runtime' }),
      listVideos: async () => [],
    },
    searchBinary: 'unused',
    searchLexicon: 'unused',
    searchData: path.join(profilePath, 'search'),
    exportFolder: path.join(profilePath, 'exports'),
    backupFolder: path.join(profilePath, 'backups'),
    createSearch: async () => ({ search: new UnavailableTranscriptSearch('test'), close: async () => undefined }),
  }),
  agentSettingsFile: path.join(profilePath, 'agent-settings.json'),
  skillPath: path.resolve('skills/xr-collector-agent'),
  uiPort: 0,
});
const collect = async (videoId: string): Promise<string> => (await (await fetch(`${runtime.listeners.ui.url}/api/items`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
})).json()).job.id;

async function recorded(id: string, matches: (job: { state: string; phase: string | null }) => boolean): Promise<void> {
  const directory = path.join(profilePath, 'jobs');
  await mkdir(directory, { recursive: true });
  const found = async () => {
    const stored = await readFile(path.join(directory, 'jobs.json'), 'utf8').then((text) => JSON.parse(text), () => null);
    const job = stored?.jobs.find((candidate: { id: string }) => candidate.id === id);
    return job !== undefined && matches(job);
  };
  await new Promise<void>((resolve, reject) => {
    let checks = Promise.resolve();
    const check = () => {
      checks = checks.then(async () => { if (await found()) { watcher.close(); resolve(); } }).catch(reject);
    };
    const watcher = watch(directory, check);
    check();
  });
}

const saved = await collect('killsaved01');
await recorded(saved, (job) => job.state === 'completed');
const stuck = await collect('killheld001');
await held;
await recorded(stuck, (job) => job.state === 'running' && job.phase === 'capture');
console.log(`jobs ${JSON.stringify([saved, stuck])}`);
console.log('holding');

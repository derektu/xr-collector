// A collector process for the restart test: it saves one video, starts capturing a second one that
// never finishes, prints both job IDs and "holding", and waits to be killed.
// Arguments: <profile directory> <Vault directory>.
import path from 'node:path';
import { CollectorRuntime } from '../../../src/runtime/collector-runtime.js';
import { UnavailableTranscriptSearch } from '../../../src/search/managed-transcript-search.js';

const [profilePath, vaultPath] = process.argv.slice(2) as [string, string];
let holding!: () => void;
const held = new Promise<void>((resolve) => { holding = resolve; });

const runtime = await CollectorRuntime.start({
  profilePath,
  explicitVaultPath: vaultPath,
  workspace: {
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
    searchData: path.join(profilePath, 'search'),
    exportFolder: path.join(profilePath, 'exports'),
    createSearch: async () => ({ search: new UnavailableTranscriptSearch('test'), close: async () => undefined }),
  },
  connectionFile: path.join(profilePath, 'agent-connection.json'),
  skillPath: path.resolve('skills/xr-collector-agent'),
  uiPort: 0,
});
const jobs = runtime.workspace!.jobs;
const saved = await jobs.submitVideo('https://www.youtube.com/watch?v=killsaved01');
await jobs.whenSettled(saved.job.id);
const stuck = await jobs.submitVideo('https://www.youtube.com/watch?v=killheld001');
await held;
console.log(`jobs ${JSON.stringify([saved.job.id, stuck.job.id])}`);
console.log('holding');

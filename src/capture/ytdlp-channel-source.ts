import { execFile } from 'node:child_process';
import type {
  DiscoveredYouTubeVideo,
  ListingPage,
  ResolvedYouTubeChannel,
  YouTubeChannelSource,
} from '../sources/youtube/adapter.js';
import { CollectorError, type YouTubeChannel } from '../core/types.js';
import { classifyYtDlpError } from './ytdlp-capture.js';

interface YtDlpChannelEntry {
  id?: string;
  title?: string;
  channel_id?: string;
  /** Present with `youtubetab:approximate_date`: the listing's relative age turned into a time. */
  timestamp?: number;
  release_timestamp?: number;
  live_status?: string;
}

interface YtDlpChannelInfo {
  id?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  uploader?: string;
  uploader_id?: string;
  entries?: YtDlpChannelEntry[];
}

type CommandRunner = (args: string[]) => Promise<string>;

export interface YtDlpChannelSourceOptions {
  binaryPath?: string;
  javaScriptRuntimePath?: string;
  timeoutMs?: number;
  run?: CommandRunner;
}

export class YtDlpChannelSource implements YouTubeChannelSource {
  private readonly binaryPath: string;
  private readonly javaScriptRuntimePath: string | null;
  private readonly timeoutMs: number;
  private readonly commandRunner: CommandRunner;

  constructor(options: YtDlpChannelSourceOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'yt-dlp';
    this.javaScriptRuntimePath = options.javaScriptRuntimePath ?? null;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.commandRunner = options.run ?? ((args) => this.runCommand(args));
  }

  async resolve(inputUrl: string): Promise<ResolvedYouTubeChannel> {
    const url = normalizeChannelUrl(inputUrl);
    const info = await this.readInfo(url, { offset: 0, limit: 1 }, true);
    const id = channelIdFromInfo(info);
    const title = info.channel?.trim() || info.uploader?.trim() || info.title?.trim();
    if (!id || !title) {
      throw new CollectorError('invalid_channel', '無法辨認這個 YouTube 頻道。');
    }
    return {
      id,
      title,
      url: `https://www.youtube.com/channel/${encodeURIComponent(id)}/videos`,
    };
  }

  async listVideos(channel: YouTubeChannel, page: ListingPage): Promise<DiscoveredYouTubeVideo[]> {
    const info = await this.readInfo(channel.url, page, false);
    const seen = new Set<string>();
    return (info.entries ?? []).flatMap((entry) => {
      const id = entry.id?.trim();
      if (!id || !/^[A-Za-z0-9_-]{11}$/u.test(id) || seen.has(id)) return [];
      seen.add(id);
      const timestamp = entry.timestamp ?? entry.release_timestamp;
      return [{
        id,
        title: entry.title?.trim() || `YouTube ${id}`,
        url: `https://www.youtube.com/watch?v=${id}`,
        publishedAt: typeof timestamp === 'number' ? new Date(timestamp * 1000).toISOString() : null,
        upcoming: entry.live_status === 'is_upcoming' || entry.live_status === 'is_live',
      }];
    });
  }

  private async readInfo(
    url: string,
    page: ListingPage,
    resolvingChannel: boolean,
  ): Promise<YtDlpChannelInfo> {
    let output: string;
    try {
      output = await this.commandRunner([
        ...this.runtimeArgs(),
        '--flat-playlist',
        '--extractor-args',
        'youtubetab:approximate_date',
        '--playlist-start',
        String(page.offset + 1),
        '--playlist-end',
        String(page.offset + page.limit),
        '--dump-single-json',
        url,
      ]);
    } catch (error) {
      if (resolvingChannel && error instanceof CollectorError && error.code !== 'network_error') {
        throw new CollectorError('invalid_channel', '無法讀取這個 YouTube 頻道。', {
          cause: error,
        });
      }
      throw error;
    }
    try {
      return JSON.parse(output) as YtDlpChannelInfo;
    } catch (error) {
      throw new CollectorError(
        resolvingChannel ? 'invalid_channel' : 'capture_failed',
        resolvingChannel ? '無法解析 YouTube 頻道資訊。' : '無法解析頻道影片清單。',
        { cause: error },
      );
    }
  }

  private runtimeArgs(): string[] {
    const runtime = this.javaScriptRuntimePath
      ? `deno:${this.javaScriptRuntimePath}`
      : `node:${process.execPath}`;
    return ['--js-runtimes', runtime, '--remote-components', 'ejs:github', '--no-progress'];
  }

  private runCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binaryPath, args, {
        timeout: this.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        reject(classifyYtDlpError(error, stderr));
      });
    });
  }
}

function normalizeChannelUrl(input: string): string {
  const trimmed = input.trim();
  const candidate = trimmed.startsWith('@')
    ? `https://www.youtube.com/${trimmed}`
    : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new CollectorError('invalid_channel', '請輸入 YouTube 頻道網址或 @handle。', {
      cause: error,
    });
  }
  const hostname = url.hostname.toLowerCase().replace(/^(?:www|m)\./u, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  const acceptedPath = first.startsWith('@')
    || (['channel', 'c', 'user'].includes(first) && Boolean(parts[1]));
  if (url.protocol !== 'https:' || hostname !== 'youtube.com' || !acceptedPath) {
    throw new CollectorError('invalid_channel', '請輸入 YouTube 頻道網址或 @handle。');
  }
  return url.toString();
}

function channelIdFromInfo(info: YtDlpChannelInfo): string | null {
  const candidates = [
    info.channel_id,
    info.uploader_id,
    info.id,
    info.entries?.[0]?.channel_id,
  ];
  return candidates.find((candidate) => /^UC[A-Za-z0-9_-]{22}$/u.test(candidate?.trim() ?? ''))
    ?.trim() ?? null;
}

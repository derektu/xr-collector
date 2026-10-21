import { execFile } from 'node:child_process';
import type {
  DiscoveredYouTubeVideo,
  ListingPage,
  RequestOptions,
  ResolvedYouTubeChannel,
  YouTubeChannelSource,
} from './adapter.js';
import { CollectorError } from '../../core/types.js';
import type { SubscriptionTarget } from '../types.js';
import { classifyYtDlpError, UNGATED, type RequestGate } from './ytdlp-capture.js';

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
  /** Every yt-dlp request waits its turn here. */
  gate?: RequestGate;
  run?: CommandRunner;
}

export class YtDlpChannelSource implements YouTubeChannelSource {
  private readonly binaryPath: string;
  private readonly javaScriptRuntimePath: string | null;
  private readonly timeoutMs: number;
  private readonly commandRunner: CommandRunner;
  private readonly gate: RequestGate;

  constructor(options: YtDlpChannelSourceOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'yt-dlp';
    this.javaScriptRuntimePath = options.javaScriptRuntimePath ?? null;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.commandRunner = options.run ?? ((args) => this.runCommand(args));
    this.gate = options.gate ?? UNGATED;
  }

  async resolve(inputUrl: string, options: RequestOptions = {}): Promise<ResolvedYouTubeChannel> {
    const url = normalizeChannelUrl(inputUrl);
    const info = await this.readInfo(url, { offset: 0, limit: 1 }, true, options);
    const id = channelIdFromInfo(info);
    const title = info.channel?.trim() || info.uploader?.trim() || info.title?.trim();
    if (!id || !title) {
      throw new CollectorError('invalid_subscription', '無法辨認這個 YouTube 頻道。');
    }
    return {
      id,
      title,
      url: `https://www.youtube.com/channel/${encodeURIComponent(id)}/videos`,
    };
  }

  async listVideos(channel: SubscriptionTarget, page: ListingPage, options: RequestOptions = {}): Promise<DiscoveredYouTubeVideo[]> {
    const info = await this.readInfo(channel.url, page, false, options);
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
    options: RequestOptions,
  ): Promise<YtDlpChannelInfo> {
    let output: string;
    try {
      output = await this.gate.run(options.priority ?? 'background', () => this.commandRunner([
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
      ]), options.signal);
    } catch (error) {
      // A request given up before it started is not an answer about the channel.
      if (options.signal?.aborted && error === options.signal.reason) throw error;
      // Temporary failures keep their own code; anything else means the address names no readable channel.
      if (resolvingChannel && error instanceof CollectorError && error.code !== 'network_error' && error.code !== 'rate_limited') {
        throw new CollectorError('invalid_subscription', '無法讀取這個 YouTube 頻道。', {
          cause: error,
        });
      }
      throw error;
    }
    try {
      return JSON.parse(output) as YtDlpChannelInfo;
    } catch (error) {
      throw new CollectorError(
        resolvingChannel ? 'invalid_subscription' : 'capture_failed',
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
    throw new CollectorError('invalid_subscription', '請輸入 YouTube 頻道網址或 @handle。', {
      cause: error,
    });
  }
  const hostname = url.hostname.toLowerCase().replace(/^(?:www|m)\./u, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  const acceptedPath = first.startsWith('@')
    || (['channel', 'c', 'user'].includes(first) && Boolean(parts[1]));
  if (url.protocol !== 'https:' || hostname !== 'youtube.com' || !acceptedPath) {
    throw new CollectorError('invalid_subscription', '請輸入 YouTube 頻道網址或 @handle。');
  }
  // A channel address without a tab makes yt-dlp read the videos, live and shorts tabs, one page
  // each. Resolving reads the videos tab alone, the tab subscriptions list from; a channel without
  // one fails here instead of after it is subscribed.
  if (parts.length === (first.startsWith('@') ? 1 : 2)) {
    url.pathname = `/${[...parts, 'videos'].join('/')}`;
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

import { publishedSince } from '../../src/channels/collection-policy.js';
import type { DocumentVault } from '../../src/core/collector.js';
import {
  CollectorError,
  type CapturedTranscript,
  type DocumentMetadata,
  type SavedDocument,
  type YouTubeChannel,
  type YouTubeVideoRef,
} from '../../src/core/types.js';
import type {
  CaptureOptions,
  DiscoveredYouTubeVideo,
  ListingPage,
  ResolvedYouTubeChannel,
  YouTubeSource,
} from '../../src/sources/youtube/adapter.js';

const DAY_MS = 24 * 60 * 60_000;

export interface SyntheticVideo {
  id: string;
  /** Exact publish time, as single-video metadata reports it. */
  publishedAt: string;
  /** What the channel listing shows; defaults to the exact time. */
  listedAt?: string | null;
  upcoming?: boolean;
}

/** An 11-character video ID made from a prefix and a number. */
export function syntheticId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(11 - prefix.length, '0')}`;
}

/** A channel ID in YouTube's `UC` + 22 characters shape. */
export function syntheticChannelId(name: string): string {
  return `UC${name.padEnd(22, 'x')}`.slice(0, 24);
}

/**
 * Synthetic YouTube channels for contract tests: listings are newest first and carry approximate
 * dates; captures check the exact date and wait while `holdCaptures` is set.
 */
export class SyntheticYouTube implements YouTubeSource {
  readonly channels = new Map<string, { title: string; videos: SyntheticVideo[] }>();
  readonly captures: string[] = [];
  readonly listingRequests: Array<{ channelId: string } & ListingPage> = [];
  /** Captures of these videos fail with the given error. */
  readonly failures = new Map<string, CollectorError>();
  holdCaptures = false;
  holdDiscovery: Promise<void> | null = null;
  discoveryFailure: CollectorError | null = null;
  private readonly waiting = new Map<string, () => void>();

  addChannel(name: string, title = `合成頻道 ${name}`): string {
    const id = syntheticChannelId(name);
    this.channels.set(id, { title, videos: [] });
    return id;
  }

  /** Publishes videos at the top of the listing; `ages` are days before `now`, newest first. */
  publish(channelId: string, prefix: string, now: Date, ages: number[], first = 0): string[] {
    const channel = this.channels.get(channelId)!;
    const added = ages.map((age, index) => ({
      id: syntheticId(prefix, first + index),
      publishedAt: new Date(now.getTime() - age * DAY_MS).toISOString(),
    }));
    channel.videos = [...added, ...channel.videos];
    return added.map((video) => video.id);
  }

  async resolveChannel(url: string): Promise<ResolvedYouTubeChannel> {
    const name = url.split('/').pop()!.replace('@', '');
    const id = syntheticChannelId(name);
    const channel = this.channels.get(id);
    if (!channel) throw new CollectorError('invalid_channel', '無法辨認這個 YouTube 頻道。');
    return { id, title: channel.title, url: `https://www.youtube.com/channel/${id}/videos` };
  }

  async discover(channel: YouTubeChannel, page: ListingPage): Promise<DiscoveredYouTubeVideo[]> {
    this.listingRequests.push({ channelId: channel.id, ...page });
    if (this.holdDiscovery) await this.holdDiscovery;
    if (this.discoveryFailure) throw this.discoveryFailure;
    const videos = this.channels.get(channel.id)?.videos ?? [];
    return videos.slice(page.offset, page.offset + page.limit).map((video) => ({
      id: video.id,
      title: `合成影片 ${video.id}`,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      publishedAt: video.listedAt === undefined ? video.publishedAt : video.listedAt,
      upcoming: video.upcoming ?? false,
    }));
  }

  async capture(video: YouTubeVideoRef, options: CaptureOptions = {}): Promise<CapturedTranscript> {
    const found = [...this.channels.entries()].flatMap(([channelId, channel]) =>
      channel.videos.filter((candidate) => candidate.id === video.videoId).map((candidate) => ({ channelId, channel, candidate })))[0];
    if (!found) throw new CollectorError('video_unavailable', '影片不存在。');
    if (options.publishedNotBefore && !publishedSince(found.candidate.publishedAt, options.publishedNotBefore)) {
      throw new CollectorError('out_of_range', '這支影片的發布時間早於收集範圍。');
    }
    this.captures.push(video.videoId);
    const failure = this.failures.get(video.videoId);
    if (failure) throw failure;
    if (this.holdCaptures) await new Promise<void>((resolve) => this.waiting.set(video.videoId, resolve));
    return {
      videoId: video.videoId, sourceUrl: video.canonicalUrl, title: `合成影片 ${video.videoId}`,
      channelId: found.channelId, channelTitle: found.channel.title, publishedAt: found.candidate.publishedAt,
      languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual', bodyMarkdown: '合成字幕',
    };
  }

  running(): string[] {
    return [...this.waiting.keys()];
  }

  release(id: string): void {
    const resolve = this.waiting.get(id);
    if (!resolve) throw new Error(`capture ${id} is not waiting`);
    this.waiting.delete(id);
    resolve();
  }
}

/** Documents kept in memory, newest collection first, stamped with a controllable clock. */
export class MemoryDocuments implements DocumentVault {
  readonly documents = new Map<string, SavedDocument>();

  constructor(private readonly now: () => Date) {}

  async getBySourceId(sourceId: string): Promise<SavedDocument | null> {
    return this.documents.get(sourceId) ?? null;
  }

  async add(capture: CapturedTranscript): Promise<SavedDocument> {
    const document: SavedDocument = {
      id: `youtube:${capture.videoId}`, type: 'Transcript', title: capture.title, sourceUrl: capture.sourceUrl,
      sourceType: 'youtube', sourceId: capture.videoId, publisher: { id: capture.channelId, name: capture.channelTitle },
      publishedAt: capture.publishedAt, collectedAt: this.now().toISOString(),
      youtube: { languageCode: capture.languageCode, languageName: capture.languageName, subtitleKind: capture.subtitleKind },
      bodyMarkdown: capture.bodyMarkdown,
    };
    this.documents.set(capture.videoId, document);
    return document;
  }

  async list(): Promise<DocumentMetadata[]> {
    return [...this.documents.values()]
      .map(({ bodyMarkdown: _body, ...metadata }) => metadata)
      .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || a.id.localeCompare(b.id));
  }

  async read(id: string): Promise<SavedDocument | null> {
    return [...this.documents.values()].find((document) => document.id === id) ?? null;
  }
}

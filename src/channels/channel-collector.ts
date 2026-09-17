import type { ChannelStore } from './json-channel-store.js';
import {
  CollectorError,
  type AddChannelResult,
  type ChannelRun,
  type ChannelRunResult,
  type CollectResult,
  type YouTubeChannel,
} from '../core/types.js';

export interface ResolvedYouTubeChannel {
  id: string;
  title: string;
  url: string;
}

export interface DiscoveredYouTubeVideo {
  id: string;
  title: string;
  url: string;
}

export interface YouTubeChannelSource {
  resolve(inputUrl: string): Promise<ResolvedYouTubeChannel>;
  listVideos(channel: YouTubeChannel, limit: number): Promise<DiscoveredYouTubeVideo[]>;
}

export interface VideoCollector {
  collect(url: string): Promise<CollectResult>;
}

export interface ChannelCollectorOptions {
  now?: () => Date;
  initialVideoLimit?: number;
  createId?: () => string;
}

export class ChannelCollector {
  private readonly now: () => Date;
  private readonly initialVideoLimit: number;
  private readonly createId: () => string;
  private readonly runs = new Map<string, ChannelRun>();
  private startingRun: Promise<ChannelRun> | null = null;

  constructor(
    private readonly source: YouTubeChannelSource,
    private readonly store: ChannelStore,
    private readonly collector: VideoCollector,
    options: ChannelCollectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.initialVideoLimit = options.initialVideoLimit ?? 10;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  listChannels(): Promise<YouTubeChannel[]> {
    return this.store.list();
  }

  async addChannel(inputUrl: string): Promise<AddChannelResult> {
    const resolved = await this.source.resolve(inputUrl);
    const existing = (await this.store.list()).find((channel) => channel.id === resolved.id);
    if (existing) return { status: 'existing', channel: existing };
    const channel: YouTubeChannel = {
      ...resolved,
      enabled: true,
      addedAt: this.now().toISOString(),
    };
    return { status: 'created', channel: await this.store.add(channel) };
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<YouTubeChannel> {
    const channel = await this.store.setEnabled(id, enabled);
    if (!channel) {
      throw new CollectorError('channel_not_found', '找不到這個 YouTube 頻道設定。');
    }
    return channel;
  }

  async removeChannel(id: string): Promise<void> {
    if (!(await this.store.remove(id))) {
      throw new CollectorError('channel_not_found', '找不到這個 YouTube 頻道設定。');
    }
  }

  startRun(channelIds?: string[]): Promise<ChannelRun> {
    const active = this.getActiveRun();
    if (active) return Promise.resolve(active);
    if (this.startingRun) return this.startingRun.then((run) => this.snapshot(run));

    const operation = this.createRun(channelIds);
    this.startingRun = operation;
    const clearStartingRun = () => {
      if (this.startingRun === operation) this.startingRun = null;
    };
    void operation.then(clearStartingRun, clearStartingRun);
    return operation;
  }

  getActiveRun(): ChannelRun | null {
    for (const run of this.runs.values()) {
      if (run.status !== 'completed') return this.snapshot(run);
    }
    return null;
  }

  private async createRun(channelIds?: string[]): Promise<ChannelRun> {
    const allChannels = await this.store.list();
    let selected: YouTubeChannel[];
    if (channelIds) {
      const uniqueIds = [...new Set(channelIds)];
      selected = uniqueIds.map((id) => {
        const channel = allChannels.find((candidate) => candidate.id === id);
        if (!channel) {
          throw new CollectorError('channel_not_found', '找不到這個 YouTube 頻道設定。');
        }
        return channel;
      });
    } else {
      selected = allChannels.filter((channel) => channel.enabled);
    }
    if (selected.length === 0) {
      throw new CollectorError('invalid_request', '沒有可執行的 YouTube 頻道。');
    }

    const run: ChannelRun = {
      id: this.createId(),
      status: 'queued',
      channelIds: selected.map((channel) => channel.id),
      currentChannelId: null,
      totalVideos: 0,
      processedVideos: 0,
      created: 0,
      existing: 0,
      failed: 0,
      results: [],
      startedAt: this.now().toISOString(),
      completedAt: null,
    };
    this.runs.set(run.id, run);
    void this.executeRun(run, selected);
    return this.snapshot(run);
  }

  getRun(id: string): ChannelRun {
    const run = this.runs.get(id);
    if (!run) {
      throw new CollectorError('channel_run_not_found', '找不到這次頻道收集執行。');
    }
    return this.snapshot(run);
  }

  private async executeRun(run: ChannelRun, channels: YouTubeChannel[]): Promise<void> {
    run.status = 'running';
    for (const channel of channels) {
      run.currentChannelId = channel.id;
      let videos: DiscoveredYouTubeVideo[];
      try {
        videos = await this.source.listVideos(channel, this.initialVideoLimit);
        run.totalVideos += videos.length;
      } catch (error) {
        run.totalVideos += 1;
        run.processedVideos += 1;
        run.failed += 1;
        run.results.push({
          channelId: channel.id,
          channelTitle: channel.title,
          videoId: null,
          videoTitle: '無法讀取頻道影片',
          url: channel.url,
          status: 'failed',
          error: errorDetails(error),
        });
        continue;
      }

      for (const video of videos) {
        try {
          const result = await this.collector.collect(video.url);
          run[result.status] += 1;
          run.results.push({
            channelId: channel.id,
            channelTitle: channel.title,
            videoId: video.id,
            videoTitle: video.title,
            url: video.url,
            status: result.status,
          });
        } catch (error) {
          run.failed += 1;
          run.results.push({
            channelId: channel.id,
            channelTitle: channel.title,
            videoId: video.id,
            videoTitle: video.title,
            url: video.url,
            status: 'failed',
            error: errorDetails(error),
          });
        } finally {
          run.processedVideos += 1;
        }
      }
    }
    run.currentChannelId = null;
    run.status = 'completed';
    run.completedAt = this.now().toISOString();
  }

  private snapshot(run: ChannelRun): ChannelRun {
    return {
      ...run,
      channelIds: [...run.channelIds],
      results: run.results.map((result) => ({
        ...result,
        ...(result.error ? { error: { ...result.error } } : {}),
      })),
    };
  }
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof CollectorError) return { code: error.code, message: error.message };
  return { code: 'capture_failed', message: '收集失敗，請稍後再試。' };
}

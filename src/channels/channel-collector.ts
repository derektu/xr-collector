import type { ChannelStore } from './json-channel-store.js';
import type { JobManager } from '../jobs/job-manager.js';
import {
  CollectorError,
  type CollectionJob,
  type JobSubmission,
  type YouTubeChannel,
} from '../core/types.js';

/** Channel settings plus the entry points that turn channels into collection jobs. */
export class ChannelCollector {
  constructor(
    private readonly store: ChannelStore,
    private readonly jobs: JobManager,
  ) {}

  listChannels(): Promise<YouTubeChannel[]> {
    return this.store.list();
  }

  /** Accepts a channel address; the job resolves it, adds the channel and collects its recent videos. */
  addChannel(inputUrl: string): Promise<JobSubmission> {
    return this.jobs.submitChannelAdd(inputUrl);
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

  /**
   * Submits one collection job per channel: the listed channels, or every enabled channel.
   * A channel whose job is still active returns that job instead of a second one.
   */
  async startRun(channelIds?: string[]): Promise<JobSubmission[]> {
    const allChannels = await this.store.list();
    let selected: YouTubeChannel[];
    if (channelIds) {
      selected = [...new Set(channelIds)].map((id) => {
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
    const submissions: JobSubmission[] = [];
    for (const channel of selected) submissions.push(await this.jobs.submitChannel(channel));
    return submissions;
  }

  whenSettled(jobId: string): Promise<CollectionJob> {
    return this.jobs.whenSettled(jobId);
  }
}

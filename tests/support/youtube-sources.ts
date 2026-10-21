import type { SourcePlugin } from '../../src/plugins/types.js';
import { type YouTubeCapture, type YouTubeChannelSource, youtubeSource } from '../../src/plugins/youtube/adapter.js';
import { youtubePlugin } from '../../src/plugins/youtube/server.js';
import type { VaultServiceOptions } from '../../src/runtime/collector-runtime.js';

/** A test's YouTube capture and channel source, from which the YouTube plugin of a workspace is built. */
export interface YouTubeTestSources {
  capture?: YouTubeCapture;
  channelSource?: YouTubeChannelSource;
}

const unusedCapture: YouTubeCapture = { capture: async () => { throw new Error('capture not provided'); } };
const unusedChannels: YouTubeChannelSource = {
  resolve: async () => { throw new Error('channel source not provided'); },
  listVideos: async () => [],
};

/** The YouTube plugin over a test capture and channel source, as the composition roots assemble it. */
export function youtubePlugins(capture: YouTubeCapture = unusedCapture, channelSource: YouTubeChannelSource = unusedChannels): SourcePlugin[] {
  return [youtubePlugin(youtubeSource(capture, channelSource))];
}

/** Options of `O` whose plugins may instead come from a YouTube capture and channel source. */
export type WithYouTube<O extends { plugins: readonly SourcePlugin[] }> = Omit<O, 'plugins'> & { plugins?: O['plugins'] } & YouTubeTestSources;

/**
 * Workspace or runtime options whose `capture` and `channelSource` become the YouTube plugin;
 * options that already name their plugins keep them.
 */
export function withYouTube<T extends WithYouTube<VaultServiceOptions>>(options: T): Omit<T, keyof YouTubeTestSources | 'plugins'> & { plugins: readonly SourcePlugin[] } {
  const { capture, channelSource, plugins, ...rest } = options;
  return { ...rest, plugins: plugins ?? youtubePlugins(capture, channelSource) };
}

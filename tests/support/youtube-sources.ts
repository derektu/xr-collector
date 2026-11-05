import type { SourcePlugin } from '../../src/core/source-contract.js';
import { type YouTubeCapture, type YouTubeChannelSource, youtubeSource } from '../../src/plugins/youtube/adapter.js';
import { rssPlugin } from '../../src/plugins/rss/server.js';
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

/**
 * The product's plugins, the YouTube one over a test capture and channel source, in the registered
 * order: a runtime starts only with every registered type's plugin. The RSS plugin reaches no feed.
 */
export function productPlugins(capture?: YouTubeCapture, channelSource?: YouTubeChannelSource): SourcePlugin[] {
  const offline = rssPlugin(async () => { throw new Error('feed fetcher not provided'); }) as unknown as SourcePlugin;
  return [...youtubePlugins(capture, channelSource), offline];
}

/** Options of `O` whose plugins may instead come from a YouTube capture and channel source. */
export type WithYouTube<O extends { plugins: readonly SourcePlugin[] }> = Omit<O, 'plugins'> & { plugins?: O['plugins'] } & YouTubeTestSources;

/**
 * Workspace or runtime options whose `capture` and `channelSource` become the YouTube plugin of the
 * product's plugins; options that already name their plugins keep them.
 */
export function withYouTube<T extends WithYouTube<VaultServiceOptions>>(options: T): Omit<T, keyof YouTubeTestSources | 'plugins'> & { plugins: readonly SourcePlugin[] } {
  const { capture, channelSource, plugins, ...rest } = options;
  return { ...rest, plugins: plugins ?? productPlugins(capture, channelSource) };
}

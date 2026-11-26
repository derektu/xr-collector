import type { SourcePlugin } from '../../src/shared/sources/source-contract.js';
import { type YouTubeCapture, type YouTubeChannelSource, youtubeSource } from '../../src/domain/sources/youtube/adapter.js';
import type { VaultServiceOptions } from '../../src/app/runtime/collector-runtime.js';
import type { WorkspaceOptions } from '../../src/app/runtime/vault-workspace.js';
import { rssPlugin } from '../../src/domain/sources/rss/server.js';
import { youtubePlugin } from '../../src/domain/sources/youtube/server.js';

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
  const offline = rssPlugin(async () => { throw new Error('feed fetcher not provided'); });
  return [...youtubePlugins(capture, channelSource), offline];
}

type YouTubeOptions<O extends { plugins: readonly SourcePlugin[] }> = Omit<O, 'plugins'> & { plugins?: O['plugins'] } & YouTubeTestSources;

/**
 * Runtime workspace options whose `capture` and `channelSource` become the YouTube plugin of the
 * product's plugins; options that already name their plugins keep them.
 */
export function withYouTube({ capture, channelSource, plugins, ...rest }: YouTubeOptions<VaultServiceOptions>): VaultServiceOptions {
  return { ...rest, plugins: plugins ?? productPlugins(capture, channelSource) };
}

/** `withYouTube` for the options of `VaultWorkspace.open`. */
export function workspaceWithYouTube({ capture, channelSource, plugins, ...rest }: YouTubeOptions<WorkspaceOptions>): WorkspaceOptions {
  return { ...rest, plugins: plugins ?? productPlugins(capture, channelSource) };
}

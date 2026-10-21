import { describe, expect, it } from 'vitest';
import { CollectorError } from '../../../src/core/types.js';
import { YtDlpChannelSource } from '../../../src/plugins/youtube/ytdlp-channel-source.js';

describe('YtDlpChannelSource', () => {
  it('resolves channel identity and lists one dated page of video references', async () => {
    const commands: string[][] = [];
    const source = new YtDlpChannelSource({
      run: async (args) => {
        commands.push(args);
        return JSON.stringify({
          id: 'UCabcdefghijklmnopqrstuv',
          channel_id: 'UCabcdefghijklmnopqrstuv',
          channel: '測試頻道',
          entries: [
            { id: 'aaaaaaaaaaa', title: '第一支', timestamp: 1791504000 },
            { id: 'bbbbbbbbbbb', title: '第二支' },
            { id: 'ccccccccccc', title: '首播', live_status: 'is_upcoming', release_timestamp: 1792000000 },
          ],
        });
      },
    });

    const resolved = await source.resolve('https://www.youtube.com/@example');
    const videos = await source.listVideos(resolved, { offset: 50, limit: 50 });

    expect(resolved).toEqual({
      id: 'UCabcdefghijklmnopqrstuv',
      title: '測試頻道',
      url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos',
    });
    expect(videos).toEqual([
      {
        id: 'aaaaaaaaaaa',
        title: '第一支',
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        publishedAt: '2026-10-09T00:00:00.000Z',
        upcoming: false,
      },
      {
        id: 'bbbbbbbbbbb',
        title: '第二支',
        url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        publishedAt: null,
        upcoming: false,
      },
      {
        id: 'ccccccccccc',
        title: '首播',
        url: 'https://www.youtube.com/watch?v=ccccccccccc',
        publishedAt: new Date(1792000000 * 1000).toISOString(),
        upcoming: true,
      },
    ]);
    expect(commands[0]).toEqual(expect.arrayContaining(['--playlist-end', '1']));
    expect(commands[1]!.join(' ')).toContain('--extractor-args youtubetab:approximate_date --playlist-start 51 --playlist-end 100');
  });

  it('rejects a video URL before invoking yt-dlp', async () => {
    let invoked = false;
    const source = new YtDlpChannelSource({
      run: async () => {
        invoked = true;
        return '{}';
      },
    });

    await expect(source.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .rejects.toEqual(expect.objectContaining<Partial<CollectorError>>({ code: 'invalid_channel' }));
    expect(invoked).toBe(false);
  });

  it('accepts a mobile YouTube channel URL', async () => {
    const source = new YtDlpChannelSource({
      run: async () => JSON.stringify({
        channel_id: 'UCabcdefghijklmnopqrstuv',
        channel: '行動版頻道',
      }),
    });

    await expect(source.resolve('https://m.youtube.com/@example/videos')).resolves.toMatchObject({
      id: 'UCabcdefghijklmnopqrstuv',
      title: '行動版頻道',
    });
  });

  it('passes a preview through the gate with its priority and keeps a YouTube limit as rate_limited', async () => {
    const passes: string[] = [];
    const source = new YtDlpChannelSource({
      gate: { run: (priority, request) => { passes.push(priority); return request(); } },
      run: async () => { throw new CollectorError('rate_limited', 'YouTube 暫時限制連線。'); },
    });
    await expect(source.resolve('https://www.youtube.com/@example', { priority: 'interactive' }))
      .rejects.toMatchObject({ code: 'rate_limited' });
    expect(passes).toEqual(['interactive']);
  });

  it('rethrows a request given up before it started instead of reading it as an unknown channel', async () => {
    const abort = new AbortController();
    const reason = new CollectorError('vault_busy', '收集步驟已暫停。');
    abort.abort(reason);
    const source = new YtDlpChannelSource({
      gate: { run: (_priority, _request, signal) => Promise.reject(signal!.reason) },
      run: async () => '{}',
    });
    await expect(source.resolve('https://www.youtube.com/@example', { signal: abort.signal })).rejects.toBe(reason);
  });
});

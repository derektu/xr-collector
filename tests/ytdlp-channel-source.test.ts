import { describe, expect, it } from 'vitest';
import { CollectorError } from '../src/core/types.js';
import { YtDlpChannelSource } from '../src/capture/ytdlp-channel-source.js';

describe('YtDlpChannelSource', () => {
  it('resolves channel identity and lists a limited set of video references', async () => {
    const commands: string[][] = [];
    const source = new YtDlpChannelSource({
      run: async (args) => {
        commands.push(args);
        return JSON.stringify({
          id: 'UCabcdefghijklmnopqrstuv',
          channel_id: 'UCabcdefghijklmnopqrstuv',
          channel: '測試頻道',
          entries: [
            { id: 'aaaaaaaaaaa', title: '第一支' },
            { id: 'bbbbbbbbbbb', title: '第二支' },
          ],
        });
      },
    });

    const resolved = await source.resolve('https://www.youtube.com/@example');
    const videos = await source.listVideos({
      ...resolved,
      enabled: true,
      addedAt: '2026-09-17T00:00:00.000Z',
    }, 10);

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
      },
      {
        id: 'bbbbbbbbbbb',
        title: '第二支',
        url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
      },
    ]);
    expect(commands[0]).toEqual(expect.arrayContaining(['--playlist-end', '1']));
    expect(commands[1]).toEqual(expect.arrayContaining(['--playlist-end', '10']));
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
});

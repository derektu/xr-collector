import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CollectorError } from '../../../src/core/types.js';
import { classifyYtDlpError, parseJson3Transcript, YtDlpCapture } from '../../../src/plugins/youtube/ytdlp-capture.js';

describe('parseJson3Transcript', () => {
  it('extracts subtitle text and preserves legitimate repetitions', () => {
    const result = parseJson3Transcript(JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: '重要提醒' }] },
        { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: '重要提醒' }] },
      ],
    }));
    expect(result).toEqual(['重要提醒', '重要提醒']);
  });

  it('joins segmented text and skips empty events', () => {
    const result = parseJson3Transcript(JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: '今天' }, { utf8: '\n來看市場' }] },
        { tStartMs: 20, segs: [] },
      ],
    }));
    expect(result).toEqual(['今天 來看市場']);
  });

  it('reports invalid subtitle JSON as capture failure', () => {
    expect(() => parseJson3Transcript('{')).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({ code: 'capture_failed' }),
    );
  });
});

describe('classifyYtDlpError', () => {
  it('maps yt-dlp unavailable wording to a user-facing unavailable result', () => {
    const result = classifyYtDlpError(
      new Error('Command failed'),
      'ERROR: [youtube] aaaaaaaaaaa: This video is unavailable',
    );
    expect(result.code).toBe('video_unavailable');
  });
});

// A video shaped like Lenny's Podcast JHo-aiePjoM: the `en` code lists 21 format groups, all
// translations (`tlang=en`) except the 4th; `en-orig` is the spoken track. yt-dlp downloads the last
// json3 entry of a code, which here is a translation.
const FORMATS = ['json3', 'srv1', 'srv2', 'srv3', 'ttml', 'srt', 'vtt'];
const group = (name: string, tlang: string | null) => FORMATS.map((ext) => ({
  ext, name, url: `https://www.youtube.com/api/timedtext?v=JHo-aiePjoM&fmt=${ext}${tlang ? `&tlang=${tlang}` : ''}`,
}));

function lennyInfo(captions: Record<string, ReturnType<typeof group>>) {
  return {
    id: 'JHo-aiePjoM', title: 'Lenny episode', channel: "Lenny's Podcast", channel_id: 'UC6t1O76G0jYXOAoYCm153dA',
    webpage_url: 'https://www.youtube.com/watch?v=JHo-aiePjoM', timestamp: 1_760_000_000, subtitles: {},
    automatic_captions: captions,
  };
}

const englishGroups = () => [
  ...Array.from({ length: 3 }, () => group('English', 'en')).flat(),
  ...group('English', null),
  ...Array.from({ length: 17 }, () => group('English', 'en')).flat(),
];

/** Runs YtDlpCapture against a scripted yt-dlp and records every call, gate pass and info file it wrote. */
async function captureWith(info: object) {
  const calls: string[][] = [];
  const gatePasses: string[] = [];
  const infoFiles: Array<Record<string, unknown>> = [];
  const capture = new YtDlpCapture({
    gate: { run: (priority, request) => { gatePasses.push(priority); return request(); } },
    run: async (args) => {
      calls.push(args);
      if (args.includes('--dump-single-json')) return { stdout: JSON.stringify(info), stderr: '' };
      infoFiles.push(JSON.parse(await readFile(args[args.indexOf('--load-info-json') + 1]!, 'utf8')) as Record<string, unknown>);
      const output = args[args.indexOf('--output') + 1]!;
      const language = args[args.indexOf('--sub-langs') + 1]!;
      await writeFile(output.replace('%(ext)s', `${language}.json3`), JSON.stringify({ events: [{ segs: [{ utf8: 'Hello there.' }] }] }));
      return { stdout: '', stderr: '' };
    },
  });
  const result = await capture.capture({ videoId: 'JHo-aiePjoM', canonicalUrl: 'https://www.youtube.com/watch?v=JHo-aiePjoM' })
    .catch((error: unknown) => error);
  return { result, calls, gatePasses, infoFiles };
}

describe('YtDlpCapture subtitle track (P-T1)', () => {
  it('downloads en-orig when the en code downloads a translation first', async () => {
    const { result, calls, gatePasses, infoFiles } = await captureWith(lennyInfo({
      en: englishGroups(), 'en-orig': group('English (Original)', null), 'zh-Hant': group('Chinese (Traditional)', 'zh-Hant'),
    }));
    expect(result).toMatchObject({ languageCode: 'en-orig', subtitleKind: 'automatic', bodyMarkdown: expect.stringContaining('Hello there.') });
    expect(calls).toHaveLength(2);
    const subtitleCall = calls[1]!;
    expect(subtitleCall[subtitleCall.indexOf('--sub-langs') + 1]).toBe('en-orig');
    // The subtitle request reads the saved information instead of the video page.
    expect(subtitleCall).toContain('--load-info-json');
    expect(subtitleCall).not.toContain('https://www.youtube.com/watch?v=JHo-aiePjoM');
    expect(gatePasses).toEqual(['background', 'background']);
    // Without the page address yt-dlp cannot load the page again after a failed download.
    expect(infoFiles[0]).not.toHaveProperty('webpage_url');
    expect(infoFiles[0]).toMatchObject({ id: 'JHo-aiePjoM', automatic_captions: expect.any(Object) });
    expect(result).toMatchObject({ sourceUrl: 'https://www.youtube.com/watch?v=JHo-aiePjoM' });
  });

  it('takes an automatic track when its last json3 format, the one yt-dlp downloads, is in the spoken language', async () => {
    const { result } = await captureWith(lennyInfo({ en: [...group('English', 'en'), ...group('English', null)] }));
    expect(result).toMatchObject({ languageCode: 'en' });
  });

  it('leaves out an automatic track whose first json3 format is original but whose last one is a translation', async () => {
    const { result, calls } = await captureWith(lennyInfo({ en: [...group('English', null), ...group('English', 'en')] }));
    expect(result).toMatchObject({ code: 'no_subtitles' });
    expect(calls).toHaveLength(1);
  });

  it('judges a code without json3 by its last format', async () => {
    const original = group('English', null).filter((format) => format.ext !== 'json3');
    const translated = group('English', 'en').filter((format) => format.ext !== 'json3');
    expect((await captureWith(lennyInfo({ en: [...translated, ...original] }))).result).toMatchObject({ languageCode: 'en' });
    expect((await captureWith(lennyInfo({ en: [...original, ...translated] }))).result).toMatchObject({ code: 'no_subtitles' });
  });

  it('collects nothing when every automatic track is a translation', async () => {
    const { result, calls } = await captureWith(lennyInfo({
      en: englishGroups().map((format) => ({ ...format, url: `${format.url.replace(/&tlang=en/u, '')}&tlang=en` })),
      'zh-Hant': group('Chinese (Traditional)', 'zh-Hant'),
    }));
    expect(result).toMatchObject({ code: 'no_subtitles' });
    expect(calls).toHaveLength(1);
  });

  it('keeps the language priority: manual first, then the preferred language', async () => {
    const info = { ...lennyInfo({ 'en-orig': group('English (Original)', null) }), subtitles: { 'zh-TW': group('中文（台灣）', null) } };
    const { result } = await captureWith(info);
    expect(result).toMatchObject({ languageCode: 'zh-TW', subtitleKind: 'manual' });
  });
});

describe('classifyYtDlpError (P-T2)', () => {
  it.each([
    'ERROR: [youtube] abc: Unable to download webpage: HTTP Error 429: Too Many Requests',
    'ERROR: [youtube] abc: Too Many Requests',
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
    'ERROR: [youtube] abc: Sign in to confirm you’re not a bot.',
    'WARNING: [youtube] Your IP is likely being blocked; you have been rate-limited by YouTube',
  ])('reads a YouTube limit as rate_limited: %s', (stderr) => {
    const error = classifyYtDlpError(new Error('Command failed'), stderr);
    expect(error.code).toBe('rate_limited');
    expect(error.detail).toBe(stderr);
  });

  it('keeps an age-restricted video unavailable', () => {
    expect(classifyYtDlpError(new Error('Command failed'), 'ERROR: [youtube] abc: Sign in to confirm your age.').code)
      .toBe('video_unavailable');
  });

  it('keeps other connection problems a network error', () => {
    expect(classifyYtDlpError(new Error('Command failed'), 'ERROR: Unable to download webpage: <urlopen error timed out>').code)
      .toBe('network_error');
    expect(classifyYtDlpError(new Error('Command failed'), 'ERROR: HTTP Error 503: Service Unavailable').code).toBe('network_error');
  });
});

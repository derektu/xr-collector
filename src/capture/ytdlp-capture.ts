import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chooseSubtitleTrack, type SubtitleTrack } from '../core/language.js';
import { formatTranscriptSegments } from '../core/transcript.js';
import {
  CollectorError,
  type CapturedTranscript,
  type YouTubeVideoRef,
} from '../core/types.js';
import { publishedSince } from '../channels/collection-policy.js';
import type { CaptureOptions, YouTubeCapture } from '../sources/youtube/adapter.js';

interface YtDlpFormat {
  name?: string;
  url?: string;
}

interface YtDlpInfo {
  id?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  uploader?: string;
  uploader_id?: string;
  webpage_url?: string;
  timestamp?: number;
  release_timestamp?: number;
  upload_date?: string;
  subtitles?: Record<string, YtDlpFormat[]>;
  automatic_captions?: Record<string, YtDlpFormat[]>;
}

interface Json3Segment {
  utf8?: string;
}

interface Json3Event {
  segs?: Json3Segment[];
}

interface Json3Transcript {
  events?: Json3Event[];
}

export interface YtDlpCaptureOptions {
  binaryPath?: string;
  javaScriptRuntimePath?: string;
  timeoutMs?: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function firstTrackName(formats: YtDlpFormat[] | undefined): string | null {
  return formats?.find((format) => format.name)?.name ?? null;
}

function tracksFromInfo(info: YtDlpInfo): SubtitleTrack[] {
  const manual = Object.entries(info.subtitles ?? {}).map(([code, formats]) => ({
    code,
    name: firstTrackName(formats),
    kind: 'manual' as const,
    isOriginal: true,
  }));
  const automatic = Object.entries(info.automatic_captions ?? {}).map(
    ([code, formats]) => ({
      code,
      name: firstTrackName(formats),
      kind: 'automatic' as const,
      isOriginal:
        code.endsWith('-orig') ||
        formats.some((format) => format.url && !new URL(format.url).searchParams.has('tlang')),
    }),
  );
  return [...manual, ...automatic];
}

function publishedAtFromInfo(info: YtDlpInfo): string | null {
  const timestamp = info.timestamp ?? info.release_timestamp;
  if (timestamp !== undefined) return new Date(timestamp * 1000).toISOString();
  if (info.upload_date && /^\d{8}$/.test(info.upload_date)) {
    return `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`;
  }
  return null;
}

export function parseJson3Transcript(input: string): string[] {
  let parsed: Json3Transcript;
  try {
    parsed = JSON.parse(input) as Json3Transcript;
  } catch (error) {
    throw new CollectorError('capture_failed', '字幕格式無法解析。', { cause: error });
  }

  return (parsed.events ?? []).flatMap((event) => {
    const text = (event.segs ?? [])
      .map((segment) => segment.utf8 ?? '')
      .join('')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!text) return [];
    return [text];
  });
}

export class YtDlpCapture implements YouTubeCapture {
  private readonly binaryPath: string;
  private readonly javaScriptRuntimePath: string | null;
  private readonly timeoutMs: number;

  constructor(options: YtDlpCaptureOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'yt-dlp';
    this.javaScriptRuntimePath = options.javaScriptRuntimePath ?? null;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async capture(video: YouTubeVideoRef, options: CaptureOptions = {}): Promise<CapturedTranscript> {
    const info = await this.readInfo(video);
    if (options.publishedNotBefore && !publishedSince(publishedAtFromInfo(info), options.publishedNotBefore)) {
      throw new CollectorError('out_of_range', '這支影片的發布時間早於補收範圍。');
    }
    const track = chooseSubtitleTrack(tracksFromInfo(info));
    if (!track) {
      throw new CollectorError('no_subtitles', '這支影片沒有可取得的既有字幕。');
    }

    const workDir = await mkdtemp(path.join(tmpdir(), 'xr-collector-caption-'));
    try {
      await this.run([
        '--no-playlist',
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        track.code,
        '--sub-format',
        'json3',
        '--output',
        path.join(workDir, 'caption.%(ext)s'),
        video.canonicalUrl,
      ]);

      const files = await readdir(workDir);
      const subtitleFile = files.find((file) => file.endsWith('.json3'));
      if (!subtitleFile) {
        throw new CollectorError('capture_failed', '字幕下載完成，但找不到字幕檔案。');
      }
      const segments = parseJson3Transcript(
        await readFile(path.join(workDir, subtitleFile), 'utf8'),
      );
      if (segments.length === 0) {
        throw new CollectorError('capture_failed', '取得的字幕沒有可閱讀內容。');
      }

      return {
        videoId: video.videoId,
        sourceUrl: info.webpage_url ?? video.canonicalUrl,
        title: info.title?.trim() || `YouTube ${video.videoId}`,
        channelId: info.channel_id ?? info.uploader_id ?? null,
        channelTitle: info.channel?.trim() || info.uploader?.trim() || '未知頻道',
        publishedAt: publishedAtFromInfo(info),
        languageCode: track.code,
        languageName: track.name,
        subtitleKind: track.kind,
        bodyMarkdown: formatTranscriptSegments(segments),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async readInfo(video: YouTubeVideoRef): Promise<YtDlpInfo> {
    const { stdout } = await this.run([
      '--no-playlist',
      '--skip-download',
      '--dump-single-json',
      video.canonicalUrl,
    ]);
    try {
      return JSON.parse(stdout) as YtDlpInfo;
    } catch (error) {
      throw new CollectorError('capture_failed', '無法解析影片資訊。', { cause: error });
    }
  }

  private runtimeArgs(): string[] {
    const runtime = this.javaScriptRuntimePath
      ? `deno:${this.javaScriptRuntimePath}`
      : `node:${process.execPath}`;
    return ['--js-runtimes', runtime, '--remote-components', 'ejs:github', '--no-progress'];
  }

  private run(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binaryPath,
        [...this.runtimeArgs(), ...args],
        {
          timeout: this.timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr });
            return;
          }
          reject(classifyYtDlpError(error, stderr));
        },
      );
    });
  }
}

export function classifyYtDlpError(
  error: Error & { code?: string | number | null },
  stderr: string,
): CollectorError {
  if (error.code === 'ENOENT') {
    return new CollectorError(
      'capture_failed',
      '找不到字幕擷取工具，請重新安裝 XR Collector。',
      { cause: error },
    );
  }

  const details = `${error.message}\n${stderr}`;
  if (
    /video (?:is )?unavailable|private video|members[- ]only|sign in to confirm|age[- ]restricted|not available/i.test(
      details,
    )
  ) {
    return new CollectorError('video_unavailable', '這支影片目前無法存取。', {
      cause: error,
    });
  }
  if (
    /timed? out|network is unreachable|temporary failure|unable to download|connection|http error 5\d\d/i.test(
      details,
    )
  ) {
    return new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。', {
      cause: error,
    });
  }
  return new CollectorError('capture_failed', '字幕取得失敗，請稍後再試。', {
    cause: error,
  });
}

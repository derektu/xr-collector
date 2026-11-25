import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chooseSubtitleTrack, type SubtitleTrack } from './language.js';
import { formatTranscriptSegments } from './transcript.js';
import { CollectorError } from '../../../shared/lib/collector-error.js';
import { publishedSince } from '../../../shared/documents/published.js';
import type { GatePriority } from '../../pacing/index.js';
import type { CaptureOptions, CapturedTranscript, YouTubeCapture } from './adapter.js';
import type { YouTubeVideoRef } from './url.js';

interface YtDlpFormat {
  ext?: string;
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

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type YtDlpRunner = (args: string[]) => Promise<CommandResult>;

export interface RequestGate {
  run<T>(priority: GatePriority, request: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export const UNGATED: RequestGate = { run: (_priority, request) => request() };

export interface YtDlpCaptureOptions {
  binaryPath?: string;
  javaScriptRuntimePath?: string;
  timeoutMs?: number;
  gate: RequestGate;
  run?: YtDlpRunner;
}

function firstTrackName(formats: YtDlpFormat[] | undefined): string | null {
  return formats?.find((format) => format.name)?.name ?? null;
}

function downloadedFormat(formats: YtDlpFormat[]): YtDlpFormat | undefined {
  return formats.findLast((format) => format.ext === 'json3') ?? formats.at(-1);
}

function isTranslation(format: YtDlpFormat | undefined): boolean {
  if (!format?.url) return true;
  try {
    return new URL(format.url).searchParams.has('tlang');
  } catch {
    return true;
  }
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
      isOriginal: code.endsWith('-orig') || !isTranslation(downloadedFormat(formats)),
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
  private readonly gate: RequestGate;
  private readonly runner: YtDlpRunner;

  constructor(options: YtDlpCaptureOptions) {
    this.binaryPath = options.binaryPath ?? 'yt-dlp';
    this.javaScriptRuntimePath = options.javaScriptRuntimePath ?? null;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.gate = options.gate;
    this.runner = options.run ?? ((args) => this.runCommand(args));
  }

  async capture(video: YouTubeVideoRef, options: CaptureOptions = {}): Promise<CapturedTranscript> {
    const { info, raw } = await this.readInfo(video, options.signal);
    if (options.publishedNotBefore && !publishedSince(publishedAtFromInfo(info), options.publishedNotBefore)) {
      throw new CollectorError('out_of_range', '這支影片的發布時間早於收集範圍。');
    }
    const track = chooseSubtitleTrack(tracksFromInfo(info));
    if (!track) {
      throw new CollectorError('no_subtitles', '這支影片沒有可取得的既有字幕。');
    }

    const workDir = await mkdtemp(path.join(tmpdir(), 'xr-collector-caption-'));
    try {
      const infoFile = path.join(workDir, 'info.json');
      // External: yt-dlp retries a failed --load-info-json download by loading webpage_url itself.
      // https://github.com/yt-dlp/yt-dlp/blob/28b379d666051e795cbb663adac85179d5ce81f7/yt_dlp/YoutubeDL.py#L3725-L3731
      const { webpage_url: _pageUrl, ...pageless } = JSON.parse(raw) as Record<string, unknown>;
      await writeFile(infoFile, JSON.stringify(pageless), 'utf8');
      await this.request([
        '--load-info-json',
        infoFile,
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        track.code,
        '--sub-format',
        'json3',
        '--output',
        path.join(workDir, 'caption.%(ext)s'),
      ], options.signal);

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

  private async readInfo(video: YouTubeVideoRef, signal: AbortSignal | undefined): Promise<{ info: YtDlpInfo; raw: string }> {
    const { stdout } = await this.request([
      '--no-playlist',
      '--skip-download',
      '--dump-single-json',
      video.canonicalUrl,
    ], signal);
    try {
      return { info: JSON.parse(stdout) as YtDlpInfo, raw: stdout };
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

  private request(args: string[], signal: AbortSignal | undefined): Promise<CommandResult> {
    return this.gate.run('background', () => this.runner([...this.runtimeArgs(), ...args]), signal);
  }

  private runCommand(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binaryPath,
        args,
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

const STDERR_TAIL_CHARS = 4000;

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
  const diagnostic = stderr.trim() ? { detail: stderr.trim().slice(-STDERR_TAIL_CHARS) } : {};
  if (/http error 429|too many requests|confirm you['’]re not a bot|rate-limited by youtube/i.test(details)) {
    return new CollectorError('rate_limited', 'YouTube 暫時限制連線。', {
      cause: error, ...diagnostic,
    });
  }
  if (
    /video (?:is )?unavailable|private video|members[- ]only|sign in to confirm your age|age[- ]restricted|not available/i.test(
      details,
    )
  ) {
    return new CollectorError('video_unavailable', '這支影片目前無法存取。', {
      cause: error, ...diagnostic,
    });
  }
  if (
    /timed? out|network is unreachable|temporary failure|unable to download|connection|http error 5\d\d/i.test(
      details,
    )
  ) {
    return new CollectorError('network_error', '無法連線到 YouTube，請稍後再試。', {
      cause: error, ...diagnostic,
    });
  }
  return new CollectorError('capture_failed', '字幕取得失敗，請稍後再試。', {
    cause: error, ...diagnostic,
  });
}

import type {
  CollectResult,
  DocumentSummary,
  SavedDocument,
  TranscriptSearch,
  YouTubeVideoRef,
} from './types.js';
import { CollectorError } from './types.js';
import { parseYouTubeVideoUrl } from './video-url.js';

export interface YouTubeCapture {
  capture(video: YouTubeVideoRef): Promise<import('./types.js').CapturedTranscript>;
}

export interface DocumentVault {
  getBySourceId(sourceId: string): Promise<SavedDocument | null>;
  add(capture: import('./types.js').CapturedTranscript): Promise<SavedDocument>;
  list(): Promise<DocumentSummary[]>;
  read(id: string): Promise<SavedDocument | null>;
}

export class Collector {
  private readonly inFlight = new Map<string, Promise<CollectResult>>();

  constructor(
    private readonly capture: YouTubeCapture,
    private readonly vault: DocumentVault,
    private readonly search?: Pick<TranscriptSearch, 'index' | 'status'>,
  ) {}

  async collect(inputUrl: string): Promise<CollectResult> {
    const video = parseYouTubeVideoUrl(inputUrl);
    const running = this.inFlight.get(video.videoId);
    if (running) return running;

    const task = this.collectOnce(video).finally(() => {
      this.inFlight.delete(video.videoId);
    });
    this.inFlight.set(video.videoId, task);
    return task;
  }

  isBusy(): boolean {
    return this.inFlight.size > 0;
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  list(): Promise<DocumentSummary[]> {
    return this.vault.list();
  }

  async read(id: string): Promise<SavedDocument> {
    const document = await this.vault.read(id);
    if (!document) {
      throw new CollectorError('document_not_found', '找不到這份文件。');
    }
    return document;
  }

  private async collectOnce(video: YouTubeVideoRef): Promise<CollectResult> {
    const existing = await this.vault.getBySourceId(video.videoId);
    if (existing) return this.finishCollection('existing', existing);

    const captured = await this.capture.capture(video);
    const document = await this.vault.add(captured);
    return this.finishCollection('created', document);
  }

  private async finishCollection(
    status: CollectResult['status'],
    document: SavedDocument,
  ): Promise<CollectResult> {
    if (this.search) {
      try {
        await this.search.index(document);
      } catch {
        // The vault is authoritative. Search status reports the failed derived update.
      }
    }
    const searchStatus = this.search?.status() ?? {
      state: 'error' as const,
      indexedDocuments: 0,
      message: '搜尋服務尚未啟用。',
    };
    return { status, document, searchStatus };
  }
}

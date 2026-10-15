import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { DocumentVault } from '../core/collector.js';
import type {
  CapturedTranscript,
  DocumentMetadata,
  SavedDocument,
  SubtitleKind,
} from '../core/types.js';

interface StoredMetadata {
  type: 'Transcript';
  title: string;
  resource: string;
  tags: string[];
  collector: {
    id: string;
    source: 'youtube';
    source_id: string;
    publisher: string;
    publisher_id?: string;
    published_at?: string;
    collected_at: string;
    content_extent: 'full';
    subtitle: {
      language_code: string;
      language_name?: string;
      kind: SubtitleKind;
    };
    source_tags: [];
  };
}

function parseFrontmatter(content: string): { metadata: StoredMetadata; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match?.[1]) throw new Error('Invalid document frontmatter');
  const metadata = parse(match[1]) as StoredMetadata;
  if (metadata?.type !== 'Transcript' || metadata?.collector?.source !== 'youtube') {
    throw new Error('Unsupported document format');
  }
  return {
    metadata,
    body: match[2] ?? '',
  };
}

function toSavedDocument(metadata: StoredMetadata, bodyMarkdown: string): SavedDocument {
  return {
    id: metadata.collector.id,
    type: 'Transcript',
    sourceType: 'youtube',
    sourceId: metadata.collector.source_id,
    sourceUrl: metadata.resource,
    title: metadata.title,
    publisher: {
      id: metadata.collector.publisher_id ?? null,
      name: metadata.collector.publisher,
    },
    publishedAt: metadata.collector.published_at ?? null,
    collectedAt: metadata.collector.collected_at,
    youtube: {
      languageCode: metadata.collector.subtitle.language_code,
      languageName: metadata.collector.subtitle.language_name ?? null,
      subtitleKind: metadata.collector.subtitle.kind,
    },
    bodyMarkdown,
  };
}

export class MarkdownVault implements DocumentVault {
  private readonly documentsDir: string;

  constructor(private readonly rootDir: string) {
    this.documentsDir = path.join(rootDir, 'documents', 'youtube');
  }

  async getBySourceId(sourceId: string): Promise<SavedDocument | null> {
    return this.read(`youtube:${sourceId}`);
  }

  async add(capture: CapturedTranscript): Promise<SavedDocument> {
    await mkdir(this.documentsDir, { recursive: true });
    const id = `youtube:${capture.videoId}`;
    const existing = await this.read(id);
    if (existing) return existing;

    const collectedAt = new Date().toISOString();
    const metadata: StoredMetadata = {
      type: 'Transcript',
      title: capture.title,
      resource: capture.sourceUrl,
      tags: [],
      collector: {
        id,
        source: 'youtube',
        source_id: capture.videoId,
        publisher: capture.channelTitle,
        collected_at: collectedAt,
        content_extent: 'full',
        subtitle: {
          language_code: capture.languageCode,
          kind: capture.subtitleKind,
        },
        source_tags: [],
      },
    };
    if (capture.channelId) metadata.collector.publisher_id = capture.channelId;
    if (capture.publishedAt) metadata.collector.published_at = capture.publishedAt;
    if (capture.languageName) metadata.collector.subtitle.language_name = capture.languageName;

    const body = capture.bodyMarkdown.trim();
    const serialized = `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}\n`;
    const finalPath = this.pathForSourceId(capture.videoId);
    const temporaryPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;

    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
    try {
      await copyFile(temporaryPath, finalPath, constants.COPYFILE_EXCL);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }

    const saved = await this.read(id);
    if (!saved) throw new Error('Document was not saved');
    return saved;
  }

  /** Metadata of every document, without bodies, newest collection first. */
  async list(): Promise<DocumentMetadata[]> {
    let files: string[];
    try {
      files = await readdir(this.documentsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const documents = await Promise.all(
      files.filter((file) => file.endsWith('.md')).map((file) => this.readFile(path.join(this.documentsDir, file))),
    );
    return documents
      .filter((document): document is SavedDocument => document !== null)
      .map(({ bodyMarkdown: _body, ...metadata }) => metadata)
      .sort((left, right) => right.collectedAt.localeCompare(left.collectedAt) || left.id.localeCompare(right.id));
  }

  async read(id: string): Promise<SavedDocument | null> {
    const match = /^youtube:([A-Za-z0-9_-]{11})$/.exec(id);
    if (!match?.[1]) return null;
    return this.readFile(this.pathForSourceId(match[1]));
  }

  private pathForSourceId(sourceId: string): string {
    return path.join(this.documentsDir, `${sourceId}.md`);
  }

  private async readFile(filePath: string): Promise<SavedDocument | null> {
    try {
      const { metadata, body } = parseFrontmatter(await readFile(filePath, 'utf8'));
      return toSavedDocument(metadata, body.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

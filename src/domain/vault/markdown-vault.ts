import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { DocumentVault } from '../../shared/documents/document-vault.js';
import type { SourceRegistry } from '../../shared/sources/source-registry.js';
import type { ContentExtent, DeletionRecord, DocumentKey, DocumentMetadata, DocumentStatus, SavedDocument } from '../../shared/documents/document-types.js';
import { storedDocumentStatus } from '../../shared/documents/document-status.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { VaultFiles } from '../../shared/vault/vault-files.js';
import type { CapturedDocument } from '../../shared/sources/source-contract.js';
import { collectedAtReadable, collectedBeforeDeletion } from '../../shared/documents/deletion-rule.js';
import { documentId } from '../../shared/documents/document-id.js';
import { DeletionLedger } from './deleted-documents.js';
import { documentKeyFromId, documentKeyFromPath, documentPath } from './document-paths.js';
import { withDocumentStatus } from './document-status-edit.js';
import { errorCode } from './errno.js';

interface StoredMetadata {
  type: string;
  title: string;
  resource: string;
  tags: string[];
  status?: DocumentStatus;
  collector: {
    id: string;
    source: string;
    source_id: string;
    publisher: string;
    publisher_id?: string;
    published_at?: string;
    collected_at: string;
    updated_at?: string;
    content_extent: ContentExtent;
    source_tags: [];
    [field: string]: unknown;
  };
}

interface ListedFile {
  relative: string;
  key: DocumentKey;
}

const DOCUMENT_FILE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(sources: SourceRegistry, content: string): { metadata: StoredMetadata; body: string } {
  const match = content.match(DOCUMENT_FILE);
  if (!match?.[1]) throw new Error('Invalid document frontmatter');
  const metadata = parse(match[1]) as StoredMetadata;
  const definition = typeof metadata?.collector?.source === 'string' ? sources.definition(metadata.collector.source) : undefined;
  if (!definition || metadata.type !== definition.item.documentType) {
    throw new Error('Unsupported document format');
  }
  return {
    metadata,
    body: match[2] ?? '',
  };
}

export class DocumentFileError extends CollectorError {
  constructor(readonly file: string, options?: ErrorOptions) {
    super('vault_invalid', `知識庫文件無法讀取，請修正或移除這個檔案後再試：${file}`, options);
    this.name = 'DocumentFileError';
  }
}

export function parseDocument(sources: SourceRegistry, content: string): SavedDocument {
  const { metadata, body } = parseFrontmatter(sources, content);
  return toSavedDocument(sources, metadata, body.trim());
}

const READ_CONCURRENCY = 16;

function toSavedDocument(sources: SourceRegistry, metadata: StoredMetadata, bodyMarkdown: string): SavedDocument {
  const sourceType = metadata.collector.source;
  const details = sources.require(sourceType).frontmatter.read(metadata.collector);
  return {
    id: metadata.collector.id,
    type: metadata.type,
    sourceType,
    sourceId: metadata.collector.source_id,
    sourceUrl: metadata.resource,
    title: metadata.title,
    publisher: {
      id: metadata.collector.publisher_id ?? null,
      name: metadata.collector.publisher,
    },
    publishedAt: metadata.collector.published_at ?? null,
    collectedAt: metadata.collector.collected_at,
    status: storedDocumentStatus(metadata.status),
    contentExtent: metadata.collector.content_extent === 'summary' ? 'summary' : 'full',
    ...(details ? { [sourceType]: details } : {}),
    bodyMarkdown,
  };
}

export interface MarkdownVaultOptions {
  now?: () => Date;
}

export interface DeletionRecovery {
  completed: DeletionRecord[];
  cleared: DeletionRecord[];
  unresolved: DeletionRecord[];
}

export class MarkdownVault implements DocumentVault {
  readonly deletions: DeletionLedger;
  readonly now: () => Date;
  readonly sources: SourceRegistry;
  private readonly rootDir: string;

  constructor(private readonly files: VaultFiles, options: MarkdownVaultOptions = {}) {
    this.rootDir = files.root;
    this.sources = files.sources;
    this.now = options.now ?? (() => new Date());
    this.deletions = new DeletionLedger(files, this.now);
  }

  async getByKey(key: DocumentKey): Promise<SavedDocument | null> {
    return this.read(documentId(key));
  }

  async add(capture: CapturedDocument, options: { collectedAt?: Date } = {}): Promise<SavedDocument> {
    const definition = this.sources.definition(capture.sourceType);
    if (!definition) throw new Error(`Source type ${capture.sourceType} is not registered`);
    const key: DocumentKey = { sourceType: capture.sourceType, sourceId: capture.key };
    const file = documentPath(key);
    const id = documentId(key);
    const existing = await this.read(id);
    if (existing) return existing;
    await this.files.remove(file);

    const collectedAt = (options.collectedAt ?? this.now()).toISOString();
    const metadata: StoredMetadata = {
      type: definition.item.documentType,
      title: capture.title,
      resource: capture.sourceUrl,
      tags: [],
      status: 'published',
      collector: {
        id,
        source: capture.sourceType,
        source_id: capture.key,
        publisher: capture.publisher.name,
        collected_at: collectedAt,
        content_extent: capture.contentExtent,
        ...definition.frontmatter.write(capture.details),
        source_tags: [],
      },
    };
    if (capture.publisher.id) metadata.collector.publisher_id = capture.publisher.id;
    if (capture.publishedAt) metadata.collector.published_at = capture.publishedAt;

    const body = capture.bodyMarkdown.trim();
    const serialized = `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}\n`;
    await this.files.create(file, serialized);

    const saved = await this.readStored(id);
    if (!saved) throw new Error('Document was not saved');
    return saved;
  }

  async list(): Promise<DocumentMetadata[]> {
    const listed: ListedFile[] = [];
    for (const definition of this.sources.definitions) {
      const folder = `documents/${definition.id}`;
      let files: string[];
      try {
        files = await readdir(path.join(this.rootDir, ...folder.split('/')));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      for (const file of files) {
        const relative = `${folder}/${file}`;
        const key = documentKeyFromPath(this.sources, relative);
        if (key !== null) listed.push({ relative, key });
      }
    }

    const deletions = await this.deletionTimes();
    const metadata: DocumentMetadata[] = [];
    for (let start = 0; start < listed.length; start += READ_CONCURRENCY) {
      const batch = await Promise.all(listed.slice(start, start + READ_CONCURRENCY).map((file) => this.readListed(file)));
      for (const document of batch) {
        if (!document || hidden(document, deletions)) continue;
        const { bodyMarkdown: _body, contentExtent: _extent, ...rest } = document;
        // V8 keeps a whole file's text alive while a substring sliced from it lives: https://crbug.com/v8/2869
        metadata.push(structuredClone(rest));
      }
    }
    return metadata.sort((left, right) => right.collectedAt.localeCompare(left.collectedAt) || left.id.localeCompare(right.id));
  }

  private async readListed({ relative, key }: ListedFile): Promise<SavedDocument | null> {
    let document: SavedDocument | null;
    try {
      document = await this.readFile(this.pathFor(key));
    } catch (error) {
      throw new DocumentFileError(relative, { cause: error });
    }
    if (document && document.id !== documentId(key)) throw new DocumentFileError(relative);
    return document;
  }

  async read(id: string): Promise<SavedDocument | null> {
    const document = await this.readStored(id);
    if (!document) return null;
    const deletion = await this.deletions.get(id);
    return deletion && collectedBeforeDeletion(document.collectedAt, deletion.deletedAt) ? null : document;
  }

  async writeStatus(id: string, status: DocumentStatus): Promise<SavedDocument> {
    const key = documentKeyFromId(this.sources, id);
    if (!key) throw new Error(`Not a document ID: ${id}`);
    const content = await readFile(this.pathFor(key), 'utf8');
    const frontmatter = content.match(DOCUMENT_FILE)?.[1];
    if (frontmatter === undefined) throw new DocumentFileError(documentPath(key));
    const text = `---\n${withDocumentStatus(frontmatter, status, this.now().toISOString())}${content.slice(4 + frontmatter.length)}`;
    const document = parseDocument(this.sources, text);
    await this.files.writeText(documentPath(key), text);
    return document;
  }

  async remove(id: string): Promise<void> {
    const key = documentKeyFromId(this.sources, id);
    if (!key) return;
    await this.files.remove(documentPath(key));
  }

  async recoverDeletions(): Promise<DeletionRecovery> {
    const recovery: DeletionRecovery = { completed: [], cleared: [], unresolved: [] };
    for (const record of await this.deletions.list()) {
      const id = documentId(record);
      const document = await this.readStored(id);
      if (!document) continue;
      if (!collectedAtReadable(document.collectedAt)) {
        recovery.unresolved.push(record);
      } else if (collectedBeforeDeletion(document.collectedAt, record.deletedAt)) {
        await this.remove(id);
        recovery.completed.push(record);
      } else {
        await this.deletions.clear(id);
        recovery.cleared.push(record);
      }
    }
    return recovery;
  }

  async portableDeletions(): Promise<DeletionRecord[]> {
    const records: DeletionRecord[] = [];
    for (const record of await this.deletions.list()) {
      let document: SavedDocument | null;
      try { document = await this.readStored(documentId(record)); } catch { document = null; }
      if (!document || collectedBeforeDeletion(document.collectedAt, record.deletedAt)) records.push(record);
    }
    return records;
  }

  private async readStored(id: string): Promise<SavedDocument | null> {
    const key = documentKeyFromId(this.sources, id);
    if (!key) return null;
    return this.readFile(this.pathFor(key));
  }

  private async deletionTimes(): Promise<Map<string, string>> {
    return new Map((await this.deletions.list()).map((record) => [documentId(record), record.deletedAt]));
  }

  private pathFor(key: DocumentKey): string {
    return path.join(this.rootDir, ...documentPath(key).split('/'));
  }

  private async readFile(filePath: string): Promise<SavedDocument | null> {
    try {
      return parseDocument(this.sources, await readFile(filePath, 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }
}

function hidden(document: SavedDocument, deletions: Map<string, string>): boolean {
  const deletedAt = deletions.get(document.id);
  return deletedAt !== undefined && collectedBeforeDeletion(document.collectedAt, deletedAt);
}

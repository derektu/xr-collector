import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { DocumentVault } from '../core/collector.js';
import { sourceDefinition, sourceDefinitions } from '../core/source-registry.js';
import type { DocumentMetadata, SavedDocument } from '../core/types.js';
import { CollectorError } from '../core/types.js';
import type { CapturedDocument } from '../plugins/types.js';
import { collectedAtReadable, collectedBeforeDeletion, DeletionLedger, deletionId, type DeletionRecord } from './deleted-documents.js';
import { documentId, documentKeyFromId, documentKeyFromPath, documentPath, type DocumentKey } from './document-paths.js';
import { ensureVaultFormat } from './vault-directory.js';

/**
 * A document file's frontmatter. The core owns these keys; the `collector` block also carries the
 * fields the source type's frontmatter codec writes, between `content_extent` and `source_tags`.
 */
interface StoredMetadata {
  type: string;
  title: string;
  resource: string;
  tags: string[];
  collector: {
    id: string;
    source: string;
    source_id: string;
    publisher: string;
    publisher_id?: string;
    published_at?: string;
    collected_at: string;
    content_extent: 'full';
    source_tags: [];
    [field: string]: unknown;
  };
}

function parseFrontmatter(content: string): { metadata: StoredMetadata; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match?.[1]) throw new Error('Invalid document frontmatter');
  const metadata = parse(match[1]) as StoredMetadata;
  const definition = typeof metadata?.collector?.source === 'string' ? sourceDefinition(metadata.collector.source) : undefined;
  if (!definition || metadata.type !== definition.item.documentType) {
    throw new Error('Unsupported document format');
  }
  return {
    metadata,
    body: match[2] ?? '',
  };
}

/**
 * A document file the Vault lists by its name (`documents/<source type>/<source ID>.md`) that cannot
 * be read as a document: unparseable frontmatter, an unsupported format, or an ID that differs from
 * the file name. Such a file is the Vault's own data gone bad, so listing and export stop and name it.
 */
export class DocumentFileError extends CollectorError {
  constructor(readonly file: string, options?: ErrorOptions) {
    super('vault_invalid', `知識庫文件無法讀取，請修正或移除這個檔案後再試：${file}`, options);
    this.name = 'DocumentFileError';
  }
}

/** A document from the text of its file; throws when the text is not a document of a registered type. */
export function parseDocument(content: string): SavedDocument {
  const { metadata, body } = parseFrontmatter(content);
  return toSavedDocument(metadata, body.trim());
}

/** How many document files a listing reads at once, so memory stays flat however large the Vault is. */
const READ_CONCURRENCY = 16;

function toSavedDocument(metadata: StoredMetadata, bodyMarkdown: string): SavedDocument {
  const sourceType = metadata.collector.source;
  const details = sourceDefinition(sourceType)!.frontmatter.read(metadata.collector);
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
    ...(details ? { [sourceType]: details } : {}),
    bodyMarkdown,
  };
}

export interface MarkdownVaultOptions {
  /** The clock behind both `collected_at` and deletion times, so the two compare on one time source. */
  now?: () => Date;
}

/** What opening a Vault found of deletions a stop left unfinished. */
export interface DeletionRecovery {
  /** Deletions whose document file was still there; the file is removed now. */
  completed: DeletionRecord[];
  /** Explicit re-collections that saved the document but did not lift the deletion; the record is lifted now. */
  cleared: DeletionRecord[];
  /**
   * Deletions whose document file has no readable `collected_at`. Both the record and the file stay,
   * and the document stays hidden, because the file cannot show whether it predates the deletion.
   */
  unresolved: DeletionRecord[];
}

/** The deletion state a package carries: which document files stay out and which records go in. */
export interface PortableDeletions {
  /** IDs of document files their deletion hides. */
  hidden: Set<string>;
  /** Records still in effect; a record whose document is newer belongs to a lifted deletion and is left out. */
  records: DeletionRecord[];
}

/**
 * Markdown documents of one Vault and its deletion records. A document with a deletion record is
 * invisible when it was collected no later than the deletion, so the record alone makes a deletion
 * take effect, before the file is gone.
 */
export class MarkdownVault implements DocumentVault {
  readonly deletions: DeletionLedger;
  readonly now: () => Date;
  /** Source types whose first document this instance has written, with the Vault format they need in place. */
  private readonly formatsEnsured = new Set<string>();

  constructor(private readonly rootDir: string, options: MarkdownVaultOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.deletions = new DeletionLedger(rootDir, this.now);
  }

  async getByKey(key: DocumentKey): Promise<SavedDocument | null> {
    return this.read(documentId(key));
  }

  /**
   * Saves a captured item unless a visible document of the same item exists, which is returned
   * instead. `collectedAt` stamps an explicit re-collection after its deletion time.
   */
  async add(capture: CapturedDocument, options: { collectedAt?: Date } = {}): Promise<SavedDocument> {
    const definition = sourceDefinition(capture.sourceType);
    if (!definition) throw new Error(`Source type ${capture.sourceType} is not registered`);
    const key: DocumentKey = { sourceType: capture.sourceType, sourceId: capture.key };
    const finalPath = this.pathFor(key);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const id = documentId(key);
    const existing = await this.read(id);
    if (existing) return existing;
    if (!this.formatsEnsured.has(capture.sourceType)) {
      await ensureVaultFormat(this.rootDir, [capture.sourceType]);
      this.formatsEnsured.add(capture.sourceType);
    }
    // A file hidden by its deletion record is the deleted document; the new one takes its place.
    await rm(finalPath, { force: true });

    const collectedAt = (options.collectedAt ?? this.now()).toISOString();
    const metadata: StoredMetadata = {
      type: definition.item.documentType,
      title: capture.title,
      resource: capture.sourceUrl,
      tags: [],
      collector: {
        id,
        source: capture.sourceType,
        source_id: capture.key,
        publisher: capture.publisher.name,
        collected_at: collectedAt,
        content_extent: 'full',
        ...definition.frontmatter.write(capture.details),
        source_tags: [],
      },
    };
    if (capture.publisher.id) metadata.collector.publisher_id = capture.publisher.id;
    if (capture.publishedAt) metadata.collector.published_at = capture.publishedAt;

    const body = capture.bodyMarkdown.trim();
    const serialized = `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}\n`;
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

    const saved = await this.readStored(id);
    if (!saved) throw new Error('Document was not saved');
    return saved;
  }

  /**
   * Metadata of every visible document of every registered source type, without bodies, newest
   * collection first. Only files named `documents/<source type>/<source ID>.md` with a valid source
   * ID are documents; any other file belongs to someone else and is not read. A document file that
   * cannot be read fails the listing with a `DocumentFileError`.
   */
  async list(): Promise<DocumentMetadata[]> {
    const relatives: string[] = [];
    for (const definition of sourceDefinitions()) {
      const folder = `documents/${definition.id}`;
      let files: string[];
      try {
        files = await readdir(path.join(this.rootDir, ...folder.split('/')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files) {
        const relative = `${folder}/${file}`;
        if (documentKeyFromPath(relative) !== null) relatives.push(relative);
      }
    }

    const deletions = await this.deletionTimes();
    const metadata: DocumentMetadata[] = [];
    for (let start = 0; start < relatives.length; start += READ_CONCURRENCY) {
      const batch = await Promise.all(relatives.slice(start, start + READ_CONCURRENCY).map((relative) => this.readListed(relative)));
      for (const document of batch) {
        if (!document || hidden(document, deletions)) continue;
        const { bodyMarkdown: _body, ...rest } = document;
        // A copy, because strings parsed out of the file can keep the whole file text in memory.
        metadata.push(structuredClone(rest));
      }
    }
    return metadata.sort((left, right) => right.collectedAt.localeCompare(left.collectedAt) || left.id.localeCompare(right.id));
  }

  /** A listed document file; its ID must match its name. */
  private async readListed(relative: string): Promise<SavedDocument | null> {
    const key = documentKeyFromPath(relative)!;
    let document: SavedDocument | null;
    try {
      document = await this.readFile(this.pathFor(key));
    } catch (error) {
      throw new DocumentFileError(relative, { cause: error });
    }
    if (document && document.id !== documentId(key)) throw new DocumentFileError(relative);
    return document;
  }

  /** A visible document; null when it does not exist or its deletion hides it. */
  async read(id: string): Promise<SavedDocument | null> {
    const document = await this.readStored(id);
    if (!document) return null;
    const deletion = await this.deletions.get(id);
    return deletion && collectedBeforeDeletion(document.collectedAt, deletion.deletedAt) ? null : document;
  }

  /** Removes a document file; a missing file is already removed. */
  async remove(id: string): Promise<void> {
    const key = documentKeyFromId(id);
    if (!key) return;
    await rm(this.pathFor(key), { force: true });
  }

  /**
   * Finishes what a stop left between a deletion record and its document file: a file collected
   * no later than its deletion is removed, and a newer file, saved by an explicit re-collection,
   * lifts the record.
   */
  async recoverDeletions(): Promise<DeletionRecovery> {
    const recovery: DeletionRecovery = { completed: [], cleared: [], unresolved: [] };
    for (const record of await this.deletions.list()) {
      const id = deletionId(record);
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

  /**
   * Applies the visibility rule to the files a package takes from this Vault, so a package never
   * holds a document next to the record that hides it, even while a deletion is unfinished.
   */
  async portableDeletions(): Promise<PortableDeletions> {
    const hidden = new Set<string>();
    const records: DeletionRecord[] = [];
    for (const record of await this.deletions.list()) {
      const id = deletionId(record);
      let document: SavedDocument | null;
      try { document = await this.readStored(id); } catch { document = null; hidden.add(id); }
      if (!document) { records.push(record); continue; }
      if (collectedBeforeDeletion(document.collectedAt, record.deletedAt)) {
        hidden.add(id);
        records.push(record);
      }
    }
    return { hidden, records };
  }

  /** A document file as stored, whether or not a deletion hides it. */
  private async readStored(id: string): Promise<SavedDocument | null> {
    const key = documentKeyFromId(id);
    if (!key) return null;
    return this.readFile(this.pathFor(key));
  }

  private async deletionTimes(): Promise<Map<string, string>> {
    return new Map((await this.deletions.list()).map((record) => [deletionId(record), record.deletedAt]));
  }

  private pathFor(key: DocumentKey): string {
    return path.join(this.rootDir, ...documentPath(key).split('/'));
  }

  private async readFile(filePath: string): Promise<SavedDocument | null> {
    try {
      return parseDocument(await readFile(filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

function hidden(document: SavedDocument, deletions: Map<string, string>): boolean {
  const deletedAt = deletions.get(document.id);
  return deletedAt !== undefined && collectedBeforeDeletion(document.collectedAt, deletedAt);
}

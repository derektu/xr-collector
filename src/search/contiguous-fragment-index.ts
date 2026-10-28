import type { SavedDocument, SearchQuery } from '../core/types.js';
import { NO_PUBLISHER_ID } from '../core/collector.js';
import { normalizeSearchText } from './search-normalization.js';

interface FragmentDocument {
  id: string;
  sourceType: string;
  publisherId: string | null;
  publishedAtEpoch: number | null;
  order: number;
  fields: [string, string, string];
  characters: Set<string>;
}

export interface NormalizedMatchPosition {
  start: number;
  length: number;
}

/** Rebuildable in-memory acceleration only; Meilisearch remains the persistent projection. */
export class ContiguousFragmentIndex {
  private readonly documents = new Map<string, FragmentDocument>();
  private readonly postings = new Map<string, Set<string>>();
  private nextOrder = 0;

  static fromDocuments(documents: SavedDocument[]): ContiguousFragmentIndex {
    const index = new ContiguousFragmentIndex();
    for (const document of documents) index.insert(projectDocument(document, index.nextOrder++));
    return index;
  }

  upsert(document: SavedDocument): void {
    const previous = this.documents.get(document.id);
    if (previous) this.remove([document.id]);
    this.insert(projectDocument(document, previous?.order ?? this.nextOrder++));
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      const existing = this.documents.get(id);
      if (!existing) continue;
      this.documents.delete(id);
      for (const character of existing.characters) {
        const posting = this.postings.get(character);
        posting?.delete(id);
        if (posting?.size === 0) this.postings.delete(character);
      }
    }
  }

  eligibleIds(groups: string[], query: SearchQuery, excludeIds: ReadonlySet<string>): string[] {
    const requiredCharacters = [...new Set(groups.flatMap((group) => [...group].filter(isHan)))];
    let candidates: Iterable<string> = this.documents.keys();
    if (requiredCharacters.length > 0) {
      const posting = requiredCharacters
        .map((character) => this.postings.get(character) ?? new Set<string>())
        .sort((left, right) => left.size - right.size)[0]!;
      candidates = posting;
    }
    const result: FragmentDocument[] = [];
    for (const id of candidates) {
      const document = this.documents.get(id);
      if (!document || excludeIds.has(id) || !matchesFilters(document, query)) continue;
      if (requiredCharacters.some((character) => !document.characters.has(character))) continue;
      if (groups.every((group) => document.fields.some((field) => field.includes(group)))) result.push(document);
    }
    return result.sort((left, right) => left.order - right.order).map(({ id }) => id);
  }

  bodyPositions(id: string, groups: string[]): NormalizedMatchPosition[] {
    const body = this.documents.get(id)?.fields[2];
    if (body === undefined) return [];
    const positions: NormalizedMatchPosition[] = [];
    for (const group of groups) {
      for (let start = body.indexOf(group); start >= 0; start = body.indexOf(group, start + Math.max(group.length, 1))) {
        positions.push({
          start: Buffer.byteLength(body.slice(0, start), 'utf8'),
          length: Buffer.byteLength(group, 'utf8'),
        });
      }
    }
    return positions.sort((left, right) => left.start - right.start || left.length - right.length);
  }

  private insert(document: FragmentDocument): void {
    this.documents.set(document.id, document);
    for (const character of document.characters) {
      const posting = this.postings.get(character) ?? new Set<string>();
      posting.add(document.id);
      this.postings.set(character, posting);
    }
  }
}

function projectDocument(document: SavedDocument, order: number): FragmentDocument {
  const fields: [string, string, string] = [
    normalizeSearchText(document.title),
    normalizeSearchText(document.publisher.name),
    normalizeSearchText(document.bodyMarkdown),
  ];
  return {
    id: document.id,
    sourceType: document.sourceType,
    publisherId: document.publisher.id,
    publishedAtEpoch: document.publishedAt ? Date.parse(document.publishedAt) : null,
    order,
    fields,
    characters: new Set(fields.flatMap((field) => [...field].filter(isHan))),
  };
}

function matchesFilters(document: FragmentDocument, query: SearchQuery): boolean {
  if (query.sourceType && document.sourceType !== query.sourceType) return false;
  if (query.publisherId === NO_PUBLISHER_ID && document.publisherId !== null) return false;
  if (query.publisherId && query.publisherId !== NO_PUBLISHER_ID && document.publisherId !== query.publisherId) return false;
  if (query.publishedFrom && (document.publishedAtEpoch === null
    || document.publishedAtEpoch < Date.parse(`${query.publishedFrom}T00:00:00.000Z`))) return false;
  if (query.publishedTo && (document.publishedAtEpoch === null
    || document.publishedAtEpoch > Date.parse(`${query.publishedTo}T23:59:59.999Z`))) return false;
  return true;
}

function isHan(character: string): boolean {
  return /\p{Script=Han}/u.test(character);
}

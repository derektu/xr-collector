import { isMap, isNode, isScalar, parseDocument, stringify, type Pair, type YAMLMap } from 'yaml';
import type { DocumentStatus } from '../../shared/documents/document-types.js';

interface Edit {
  start: number;
  end: number;
  text: string;
}

export function withDocumentStatus(frontmatter: string, status: DocumentStatus, updatedAt: string): string {
  const document = parseDocument(frontmatter);
  const root = document.contents;
  if (!isMap(root) || root.flow) return rewritten(frontmatter, status, updatedAt);
  const collectorPair = pairOf(root, 'collector');
  if (!collectorPair || !isMap(collectorPair.value) || collectorPair.value.flow) return rewritten(frontmatter, status, updatedAt);
  const collector = collectorPair.value;

  const statusPair = pairOf(root, 'status');
  const statusEdit = statusPair
    ? valueEdit(frontmatter, statusPair, status)
    : lineBefore(frontmatter, collectorPair, `status: ${scalar(status)}`);
  const updatedPair = pairOf(collector, 'updated_at');
  const updatedEdit = updatedPair
    ? valueEdit(frontmatter, updatedPair, updatedAt)
    : lineAfter(frontmatter, pairOf(collector, 'collected_at') ?? collector.items.at(-1), `updated_at: ${scalar(updatedAt)}`);
  if (!statusEdit || !updatedEdit) return rewritten(frontmatter, status, updatedAt);

  let text = frontmatter;
  for (const edit of [statusEdit, updatedEdit].sort((left, right) => right.start - left.start)) {
    text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
  }
  return holds(text, status, updatedAt) ? text : rewritten(frontmatter, status, updatedAt);
}

function rewritten(frontmatter: string, status: DocumentStatus, updatedAt: string): string {
  const document = parseDocument(frontmatter);
  document.set('status', status);
  document.setIn(['collector', 'updated_at'], updatedAt);
  return document.toString({ lineWidth: 0 }).trimEnd();
}

function holds(text: string, status: DocumentStatus, updatedAt: string): boolean {
  const document = parseDocument(text);
  if (document.errors.length > 0) return false;
  const value = document.toJS() as { status?: unknown; collector?: { updated_at?: unknown } } | null;
  return value?.status === status && value.collector?.updated_at === updatedAt;
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function valueEdit(source: string, pair: Pair, value: string): Edit | null {
  const range = isScalar(pair.value) ? pair.value.range : null;
  if (!range || range[0] === range[1] || source.slice(range[0], range[1]).includes('\n')) return null;
  return { start: range[0], end: range[1], text: scalar(value) };
}

function lineBefore(source: string, pair: Pair, line: string): Edit | null {
  const keyStart = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
  if (keyStart === undefined) return null;
  const lineStart = source.lastIndexOf('\n', keyStart - 1) + 1;
  return { start: lineStart, end: lineStart, text: `${source.slice(lineStart, keyStart)}${line}\n` };
}

function lineAfter(source: string, pair: Pair | undefined, line: string): Edit | null {
  const keyStart = pair && isScalar(pair.key) ? pair.key.range?.[0] : undefined;
  const valueEnd = isNode(pair?.value) ? pair.value.range?.[1] : undefined;
  if (keyStart === undefined || valueEnd === undefined) return null;
  const indent = source.slice(source.lastIndexOf('\n', keyStart - 1) + 1, keyStart);
  const newline = source.indexOf('\n', Math.max(keyStart, valueEnd - 1));
  return newline < 0
    ? { start: source.length, end: source.length, text: `\n${indent}${line}` }
    : { start: newline + 1, end: newline + 1, text: `${indent}${line}\n` };
}

function scalar(value: string): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

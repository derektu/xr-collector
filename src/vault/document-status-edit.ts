import { isMap, isScalar, parseDocument, stringify, type Pair, type YAMLMap } from 'yaml';
import type { DocumentStatus } from '../core/document-types.js';

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * The frontmatter text (between the `---` lines) with the top-level `status` and
 * `collector.updated_at` set. Only those two values change: an existing value is replaced where it
 * stands, a missing `status` goes on the line before `collector`, and a missing `updated_at` on the
 * line after `collected_at`, so every other field, comment and formatting choice keeps its bytes.
 * Frontmatter that is not block style is written out again whole, with the same values.
 */
export function withDocumentStatus(frontmatter: string, status: DocumentStatus, updatedAt: string): string {
  const document = parseDocument(frontmatter);
  const root = document.contents;
  const collector = isMap(root) ? root.get('collector', true) : undefined;
  if (!isMap(root) || root.flow || !isMap(collector) || collector.flow) return rewritten(frontmatter, status, updatedAt);

  const statusPair = pairOf(root, 'status');
  const statusEdit = statusPair
    ? valueEdit(frontmatter, statusPair, status)
    : lineBefore(frontmatter, pairOf(root, 'collector')!, `status: ${scalar(status)}`);
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

/** The same frontmatter written out again by the YAML library, for a shape the in-place edit does not handle. */
function rewritten(frontmatter: string, status: DocumentStatus, updatedAt: string): string {
  const document = parseDocument(frontmatter);
  document.set('status', status);
  document.setIn(['collector', 'updated_at'], updatedAt);
  return document.toString({ lineWidth: 0 }).trimEnd();
}

/** Whether the edited text reads back with both values set. */
function holds(text: string, status: DocumentStatus, updatedAt: string): boolean {
  const document = parseDocument(text);
  if (document.errors.length > 0) return false;
  const value = document.toJS() as { status?: unknown; collector?: { updated_at?: unknown } } | null;
  return value?.status === status && value.collector?.updated_at === updatedAt;
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

/** Replaces the value of an existing `key: value` line; null when the value is not a one-line scalar. */
function valueEdit(source: string, pair: Pair, value: string): Edit | null {
  const range = isScalar(pair.value) ? pair.value.range : null;
  if (!range || range[0] === range[1] || source.slice(range[0], range[1]).includes('\n')) return null;
  return { start: range[0], end: range[1], text: scalar(value) };
}

/** A new line holding `line` right before the line of `pair`, at the same indentation. */
function lineBefore(source: string, pair: Pair, line: string): Edit | null {
  const keyStart = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
  if (keyStart === undefined) return null;
  const lineStart = source.lastIndexOf('\n', keyStart - 1) + 1;
  return { start: lineStart, end: lineStart, text: `${source.slice(lineStart, keyStart)}${line}\n` };
}

/** A new line holding `line` right after the last line of `pair`, at the same indentation. */
function lineAfter(source: string, pair: Pair | undefined, line: string): Edit | null {
  const keyStart = pair && isScalar(pair.key) ? pair.key.range?.[0] : undefined;
  const valueEnd = (pair?.value as { range?: [number, number, number] } | null | undefined)?.range?.[1];
  if (keyStart === undefined || valueEnd === undefined) return null;
  const indent = source.slice(source.lastIndexOf('\n', keyStart - 1) + 1, keyStart);
  const newline = source.indexOf('\n', Math.max(keyStart, valueEnd - 1));
  return newline < 0
    ? { start: source.length, end: source.length, text: `\n${indent}${line}` }
    : { start: newline + 1, end: newline + 1, text: `${indent}${line}\n` };
}

/** A scalar as the rest of the frontmatter writes it. */
function scalar(value: string): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

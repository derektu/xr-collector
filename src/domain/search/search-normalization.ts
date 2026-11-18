import { Converter, Locale, Trie } from 'opencc-js';
import type { DictGroup, DictLike } from 'opencc-js';

export const SEARCH_NORMALIZATION_REVISION = 1;
export const OPENCC_DATA_VERSION = '1.4.2';

interface Unit { text: string; rawStart: number; rawEnd: number }

export interface NormalizedText {
  text: string;
  /** Converts a UTF-8 byte range in normalized text back to a UTF-16 range in the original text. */
  rawRange(start: number, length: number): { start: number; end: number } | null;
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const s2t = Converter({ from: 'cn', to: 't' });
const t2tw = Converter({ from: 't', to: 'tw' });
const openCcStages = {
  s2t: buildOpenCcStages('s2t'),
  t2tw: buildOpenCcStages('t2tw'),
};

/** The search-only projection; Vault content and displayed fields always retain the original text. */
export function normalizeSearchText(raw: string): string {
  const nfkc = raw.normalize('NFKC').replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  return t2tw(s2t(nfkc)).replaceAll('臺', '台')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ | $/gu, '');
}

export function normalizeSearchTextWithMap(raw: string): NormalizedText {
  let units = nfkcUnits(raw);
  units = units.map((unit) => ({ ...unit, text: unit.text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()) }));
  units = applyOpenCcConfig(units, 's2t');
  units = applyOpenCcConfig(units, 't2tw');
  units = units.flatMap((unit) => [...unit.text].map((text) => ({
    text: text === '臺' ? '台' : text, rawStart: unit.rawStart, rawEnd: unit.rawEnd,
  })));
  units = collapseWhitespace(units);
  const text = units.map((unit) => unit.text).join('');
  const ranges = byteRanges(units);
  return {
    text,
    rawRange(start, length) {
      if (!Number.isInteger(start) || !Number.isInteger(length) || length <= 0) return null;
      const end = start + length;
      let rawStart = Number.POSITIVE_INFINITY;
      let rawEnd = -1;
      let low = 0;
      let high = ranges.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (ranges[middle]!.byteEnd <= start) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < ranges.length; index += 1) {
        const range = ranges[index]!;
        if (range.byteStart >= end) break;
        rawStart = Math.min(rawStart, range.rawStart);
        rawEnd = Math.max(rawEnd, range.rawEnd);
      }
      return rawEnd < 0 ? null : { start: rawStart, end: rawEnd };
    },
  };
}

function nfkcUnits(raw: string): Unit[] {
  const result: Unit[] = [];
  for (const segment of graphemes.segment(raw)) {
    const rawStart = segment.index;
    const rawEnd = rawStart + segment.segment.length;
    for (const text of segment.segment.normalize('NFKC')) result.push({ text, rawStart, rawEnd });
  }
  return result;
}

function applyOpenCcConfig(units: Unit[], name: 's2t' | 't2tw'): Unit[] {
  let converted = units;
  for (const trie of openCcStages[name]) converted = applyTrie(converted, trie);
  return converted;
}

function buildOpenCcStages(name: 's2t' | 't2tw'): Trie[] {
  const config = Locale.configs[name];
  if (!config) throw new Error(`OpenCC configuration ${name} is unavailable.`);
  const normalizationChain = (config as typeof config & { normalizationChain?: readonly DictGroup[] }).normalizationChain ?? [];
  return [...normalizationChain, ...config.conversionChain].map((group) => {
    const trie = new Trie();
    trie.loadDictGroup(group as readonly DictLike[]);
    return trie;
  });
}

function applyTrie(units: Unit[], trie: Trie): Unit[] {
  const text = units.map((unit) => unit.text).join('');
  const starts: number[] = [];
  let cursor = 0;
  for (const unit of units) { starts.push(cursor); cursor += unit.text.length; }

  const output: Unit[] = [];
  let unitIndex = 0;
  while (unitIndex < units.length) {
    const match = trie.matchPrefix(text, starts[unitIndex]!);
    if (!match) { output.push(units[unitIndex]!); unitIndex += 1; continue; }
    let after = unitIndex;
    while (after < units.length && starts[after]! < match.end) after += 1;
    const covered = units.slice(unitIndex, after);
    const replacements = [...match.value];
    if (replacements.length === covered.length) {
      replacements.forEach((text, index) => output.push({ ...covered[index]!, text }));
    } else {
      let rawStart = Number.POSITIVE_INFINITY;
      let rawEnd = -1;
      for (const unit of covered) {
        rawStart = Math.min(rawStart, unit.rawStart);
        rawEnd = Math.max(rawEnd, unit.rawEnd);
      }
      for (const replacement of replacements) output.push({ text: replacement, rawStart, rawEnd });
    }
    unitIndex = after;
  }
  return output;
}

function collapseWhitespace(units: Unit[]): Unit[] {
  const output: Unit[] = [];
  let whitespace: Unit[] = [];
  const flush = () => {
    if (whitespace.length > 0 && output.length > 0) {
      let rawStart = Number.POSITIVE_INFINITY;
      let rawEnd = -1;
      for (const unit of whitespace) { rawStart = Math.min(rawStart, unit.rawStart); rawEnd = Math.max(rawEnd, unit.rawEnd); }
      output.push({ text: ' ', rawStart, rawEnd });
    }
    whitespace = [];
  };
  for (const unit of units) {
    if (/^\p{White_Space}$/u.test(unit.text)) whitespace.push(unit);
    else { flush(); output.push(unit); }
  }
  return output;
}

function byteRanges(units: Unit[]) {
  let byteStart = 0;
  return units.map((unit) => {
    const byteEnd = byteStart + Buffer.byteLength(unit.text, 'utf8');
    const range = { byteStart, byteEnd, rawStart: unit.rawStart, rawEnd: unit.rawEnd };
    byteStart = byteEnd;
    return range;
  });
}

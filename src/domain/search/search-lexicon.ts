import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface LexiconToken {
  word: string;
  start: number;
  end: number;
}

export interface SearchLexicon {
  cut(text: string): LexiconToken[];
}

export async function loadSearchLexicon(lexiconPath: string): Promise<SearchLexicon> {
  const absoluteLexicon = path.resolve(lexiconPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absoluteLexicon);
  } catch (error) {
    throw new Error(`Search lexicon resource is missing: ${absoluteLexicon}.`, { cause: error });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Search lexicon is not valid UTF-8: ${absoluteLexicon}.`, { cause: error });
  }
  const dictionary = parseDictionary(text);
  return { cut: (value) => cutWithDictionary(value, dictionary) };
}

interface Dictionary {
  frequencies: Map<string, number>;
  total: number;
  maxWordLength: number;
}

function parseDictionary(text: string): Dictionary {
  const frequencies = new Map<string, number>();
  let total = 0;
  let maxWordLength = 1;
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/u)) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    const fields = line.split(/\s+/u);
    if (fields.length < 2 || fields.length > 3 || !/^[0-9]+$/u.test(fields[1]!)) {
      throw new Error(`Search lexicon line ${lineNumber} must be word frequency [tag].`);
    }
    const word = fields[0]!;
    const frequency = Number(fields[1]);
    if (!Number.isSafeInteger(frequency) || frequency <= 0 || frequencies.has(word)) {
      throw new Error(`Search lexicon line ${lineNumber} has an invalid frequency or duplicate word.`);
    }
    frequencies.set(word, frequency);
    total += frequency;
    maxWordLength = Math.max(maxWordLength, [...word].length);
  }
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Search lexicon total frequency is invalid.');
  return { frequencies, total, maxWordLength };
}

function cutWithDictionary(text: string, dictionary: Dictionary): LexiconToken[] {
  const tokens: LexiconToken[] = [];
  let blockStart = 0;
  let blockKind: boolean | null = null;
  const flush = (end: number) => {
    if (blockKind === null || end === blockStart) return;
    const block = text.slice(blockStart, end);
    if (blockKind) tokens.push(...cutMatchedBlock(block, blockStart, dictionary));
    else tokens.push(...cutUnmatchedBlock(block, blockStart));
  };
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index)!);
    const kind = isJiebaMatchedCharacter(character);
    if (blockKind === null) blockKind = kind;
    else if (kind !== blockKind) {
      flush(index);
      blockStart = index;
      blockKind = kind;
    }
    index += character.length;
  }
  flush(text.length);
  return tokens;
}

function cutMatchedBlock(block: string, base: number, dictionary: Dictionary): LexiconToken[] {
  const starts: number[] = [];
  for (let index = 0; index < block.length;) {
    starts.push(index);
    index += String.fromCodePoint(block.codePointAt(index)!).length;
  }
  starts.push(block.length);
  const routes: Array<{ score: number; next: number }> = new Array(starts.length);
  routes[starts.length - 1] = { score: 0, next: starts.length - 1 };
  const logTotal = Math.log(dictionary.total);
  for (let startIndex = starts.length - 2; startIndex >= 0; startIndex -= 1) {
    let best: { score: number; next: number } | null = null;
    const maxEnd = Math.min(starts.length - 1, startIndex + dictionary.maxWordLength);
    for (let endIndex = startIndex + 1; endIndex <= maxEnd; endIndex += 1) {
      const word = block.slice(starts[startIndex]!, starts[endIndex]!);
      const frequency = dictionary.frequencies.get(word);
      if (frequency === undefined) continue;
      const score = Math.log(frequency) - logTotal + routes[endIndex]!.score;
      if (!best || score > best.score || (score === best.score && endIndex > best.next)) {
        best = { score, next: endIndex };
      }
    }
    routes[startIndex] = best ?? {
      score: -logTotal + routes[startIndex + 1]!.score,
      next: startIndex + 1,
    };
  }

  const raw: LexiconToken[] = [];
  for (let index = 0; index < starts.length - 1;) {
    const next = routes[index]!.next;
    raw.push({ word: block.slice(starts[index]!, starts[next]!), start: base + starts[index]!, end: base + starts[next]! });
    index = next;
  }
  const output: LexiconToken[] = [];
  let asciiRun: LexiconToken | null = null;
  const flushAscii = () => {
    if (asciiRun) output.push(asciiRun);
    asciiRun = null;
  };
  for (const token of raw) {
    if (/^[A-Za-z0-9]$/u.test(token.word)) {
      if (asciiRun) {
        asciiRun.word += token.word;
        asciiRun.end = token.end;
      } else asciiRun = { ...token };
      continue;
    }
    flushAscii();
    output.push({ ...token });
  }
  flushAscii();
  return output;
}

function cutUnmatchedBlock(block: string, base: number): LexiconToken[] {
  const result: LexiconToken[] = [];
  for (let index = 0; index < block.length;) {
    const character = String.fromCodePoint(block.codePointAt(index)!);
    let end = index + character.length;
    if (character === '\r' && block[end] === '\n') end += 1;
    result.push({ word: block.slice(index, end), start: base + index, end: base + end });
    index = end;
  }
  return result;
}

function isJiebaMatchedCharacter(character: string): boolean {
  const point = character.codePointAt(0)!;
  return (point >= 0x3400 && point <= 0x4dbf)
    || (point >= 0x4e00 && point <= 0x9fff)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0x20000 && point <= 0x2ebef)
    || (point >= 0x2f800 && point <= 0x2fa1f)
    || /^[A-Za-z0-9+#&._%\-]$/u.test(character);
}

export interface DiffLine { kind: 'same' | 'removed' | 'added'; text: string }
/** Bound memory for long transcripts; large changes retain all lines as a replacement. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split('\n'); const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const a = left.slice(prefix, left.length - suffix); const b = right.slice(prefix, right.length - suffix);
  const middle: DiffLine[] = [];
  if (a.length * b.length > 1_000_000) {
    middle.push(...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text })));
  } else {
    const width = b.length + 1; const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
    let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { middle.push({ kind: 'same', text: a[i++]! }); j++; }
      else if (i < a.length && (j === b.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) middle.push({ kind: 'removed', text: a[i++]! });
      else middle.push({ kind: 'added', text: b[j++]! });
    }
  }
  return [...left.slice(0, prefix).map((text) => ({ kind: 'same' as const, text })), ...middle,
    ...left.slice(left.length - suffix).map((text) => ({ kind: 'same' as const, text }))];
}

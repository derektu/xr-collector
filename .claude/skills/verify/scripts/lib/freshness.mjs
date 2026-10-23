// Whether the evidence of an issue still matches the code. Every results.json records the checkout
// it tested with that checkout's commit and sourceHash (uncommitted changes included); evidence is
// current while the checkout still has both, and STALE once either differs, so a report never cites
// a run of code that has since changed. Evidence fetched from another machine names a checkout that
// does not exist here; it is compared with the checkout doctor runs in, and says so.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { commitOf } from './paths.mjs';

/**
 * Every results.json under `root` (the issue's evidence folder) compared with its checkout:
 * { root, stale, folders: [{ results, status: 'current' | 'STALE' | 'unreadable', checkout, comparedWith,
 * recorded, now, reasons }] }. `local` is the checkout that stands in for a recorded checkout missing
 * on this machine.
 */
export function evidenceFreshness(root, { local }) {
  const folders = existsSync(root) ? resultFiles(root).map((file) => freshness(root, file, local)) : [];
  return { root, stale: folders.filter((folder) => folder.status === 'STALE').length, folders };
}

function resultFiles(root) {
  return readdirSync(root, { recursive: true })
    .filter((relative) => path.basename(relative) === 'results.json')
    .map((relative) => path.join(root, relative))
    .sort();
}

function freshness(root, file, local) {
  const results = path.relative(root, file);
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { results, status: 'unreadable', reasons: [error.message] };
  }
  const reasons = [];
  const present = Boolean(recorded.checkout) && existsSync(recorded.checkout);
  const comparedWith = present ? recorded.checkout : local;
  if (!present) reasons.push(`compared with this checkout (${local}): the recorded checkout ${recorded.checkout ?? '(none)'} does not exist here`);
  const now = commitOf(comparedWith);
  const short = (sha) => String(sha ?? '(none)').slice(0, 12);
  const commitDiffers = recorded.commit !== now.commit;
  const sourceDiffers = recorded.sourceHash !== now.sourceHash;
  if (commitDiffers) reasons.push(`commit differs: ${short(recorded.commit)} recorded, ${short(now.commit)} now`);
  if (sourceDiffers) reasons.push(`sourceHash differs: ${recorded.sourceHash ?? '(none)'} recorded, ${now.sourceHash} now${commitDiffers ? '' : ' (uncommitted changes differ)'}`);
  return {
    results, status: commitDiffers || sourceDiffers ? 'STALE' : 'current', checkout: recorded.checkout ?? null, comparedWith,
    recorded: { commit: recorded.commit ?? null, sourceHash: recorded.sourceHash ?? null }, now: { commit: now.commit, sourceHash: now.sourceHash }, reasons,
  };
}

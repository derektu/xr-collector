// Whether evidence proves the code as it is now. Every results.json records the checkout it tested
// with that checkout's commit and sourceHash (uncommitted changes included). A result counts while
// the checkout still has both; a result from another machine, whose checkout does not exist here,
// counts when it tested this checkout's commit from a clean checkout. The counted results complete the
// evidence when every scenario passed on every required platform: a pass never hides a failure of the
// same scenario on the same platform, a run that failed as a whole (an `error` recorded after the
// scenarios, or `passed: false`) keeps it incomplete, and an expected scenario no run recorded stays
// pending. Results that do not count are listed with the reason, so a report never cites a run of
// code that has since changed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { commitOf } from './paths.mjs';

/** Every results.json named in `paths`: the files themselves, and those under each folder. */
export function resultFiles(paths) {
  return paths.flatMap((given) => {
    const file = path.resolve(given);
    if (!existsSync(file)) throw new Error(`${file} does not exist`);
    if (!statSync(file).isDirectory()) return [file];
    return readdirSync(file, { recursive: true }).map(String)
      .filter((relative) => path.basename(relative) === 'results.json')
      .map((relative) => path.join(file, relative)).sort();
  });
}

/** The platform a results.json was produced on: the machine it ran on, or the Desktop target's. */
const platformOf = (result) => result.environment?.platform ?? result.target?.platform ?? null;

/**
 * Why a result does not prove the current code, or null when it does. `local` is the commit and
 * sourceHash of `checkout`, the checkout the command runs in.
 */
function staleness(result, { checkout, local }) {
  const short = (sha) => String(sha ?? '(none)').slice(0, 12);
  if (!result.checkout || !existsSync(result.checkout)) {
    if (result.commit !== local.commit) return `from another machine: commit ${short(result.commit)}, this checkout ${short(local.commit)}`;
    if (result.dirty) return 'from another machine: its checkout had uncommitted changes';
    if (local.dirty) return 'from another machine: it tested the commit without the uncommitted changes in this checkout';
    return null;
  }
  // A run of another checkout on this machine, such as a baseline of the main checkout, tested
  // that checkout's code, not this one's.
  if (path.resolve(result.checkout) !== path.resolve(checkout)) return `another checkout: ${result.checkout}`;
  if (result.commit !== local.commit) return `commit differs: ${short(result.commit)} recorded, ${short(local.commit)} now`;
  if (result.sourceHash !== local.sourceHash) return `uncommitted changes differ: sourceHash ${result.sourceHash ?? '(none)'} recorded, ${local.sourceHash} now`;
  return null;
}

/**
 * Checks results.json files against the code: { checkout, commit, sourceHash, complete, platforms,
 * scenarios, failedRuns, ignored }. `platforms` lists the platforms every scenario needs ('darwin',
 * 'win32'); empty means any one platform is enough. `scenarios` lists scenario IDs the flow must
 * record. Each scenario lists one check per required platform with status pass, fail or pending.
 */
export function checkEvidence(files, { checkout, platforms = [], scenarios: expected = [] }) {
  const local = commitOf(checkout);
  const ignored = [];
  const counted = [];
  for (const file of files) {
    let result;
    try {
      result = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      ignored.push({ file, reason: `cannot be read: ${error.message}` });
      continue;
    }
    const platform = platformOf(result);
    const stale = staleness(result, { checkout, local });
    if (stale) ignored.push({ file, reason: stale });
    else if (!platform) ignored.push({ file, reason: 'no platform recorded' });
    else if (!Array.isArray(result.results)) ignored.push({ file, reason: 'no scenario results recorded' });
    else counted.push({ file, platform, result });
  }
  const failedRuns = counted.filter(({ result }) => result.error || result.passed === false)
    .map(({ file, result }) => ({ file, reason: result.error ? String(result.error).split('\n')[0] : 'the run did not pass' }));
  const ids = [...new Set([...expected, ...counted.flatMap(({ result }) => result.results.map((scenario) => scenario.id))])];
  const required = platforms.length ? platforms : ['any'];
  const scenarios = ids.map((id) => ({
    id,
    checks: required.map((platform) => {
      const runs = counted.filter((run) => platform === 'any' || run.platform === platform)
        .flatMap((run) => run.result.results.filter((scenario) => scenario.id === id));
      const status = runs.some((run) => !run.pass) ? 'fail' : runs.length ? 'pass' : 'pending';
      return { platform, status };
    }),
  }));
  return {
    checkout, commit: local.commit, sourceHash: local.sourceHash, platforms: required,
    complete: scenarios.length > 0 && failedRuns.length === 0 && scenarios.every((scenario) => scenario.checks.every((check) => check.status === 'pass')),
    scenarios, failedRuns, ignored,
  };
}

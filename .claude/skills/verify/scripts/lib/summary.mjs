// Whether the results of one version are complete across platforms. A ticket that needs Mac and
// Windows is verified by runs on two machines, each writing its own results.json; summarize reads
// them together. Only results of the commit under test count, and only from a clean checkout: a
// dirty run tests code no commit holds, so it is provisional. A scenario is complete when each
// required platform has a pass for it and no run of that platform failed it; a pass never hides a
// failure of the same scenario on the same platform.
import { readFileSync } from 'node:fs';

/** The platform a results.json was produced on: the machine it ran on, or the Desktop target's. */
const platformOf = (result) => result.environment?.platform ?? result.target?.platform ?? null;

/**
 * Summarizes results.json files of one commit: { commit, platforms, complete, scenarios, ignored }.
 * `platforms` lists the platforms every scenario needs ('darwin', 'win32'); empty means any one
 * platform is enough. Each scenario lists one check per required platform (or one for 'any') with
 * status pass, fail or pending. `ignored` names each file that does not count and why.
 */
export function summarize(files, { commit, platforms = [] }) {
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) throw new Error('summary needs the full 40-character commit under test');
  const ignored = [];
  const counted = [];
  for (const { file, result } of files) {
    const platform = platformOf(result);
    if (result.commit !== commit) ignored.push({ file, reason: `commit ${result.commit} is not ${commit}` });
    else if (result.dirty) ignored.push({ file, reason: 'provisional: the checkout had uncommitted changes' });
    else if (!platform) ignored.push({ file, reason: 'no platform recorded' });
    else counted.push({ platform, result });
  }
  const ids = [...new Set(files.flatMap(({ result }) => (result.results ?? []).map((scenario) => scenario.id)))];
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
    commit, platforms: required, complete: scenarios.length > 0 && scenarios.every((scenario) => scenario.checks.every((check) => check.status === 'pass')),
    scenarios, ignored,
  };
}

/** Reads results.json files for summarize. */
export const readResults = (paths) => paths.map((file) => ({ file, result: JSON.parse(readFileSync(file, 'utf8')) }));

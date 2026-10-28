#!/usr/bin/env node
// Whether a push to main may reuse the Web regression its pull request already passed. Pull requests
// merge by rebase, so main usually receives exactly the tree the pull request's last commit had; the
// Web regression of that commit's pull_request run then tested the same files. Reuse needs all of:
// a pull request into main containing the pushed commit, the same tree as its last commit, and a
// successful Web regression job in a pull_request run of that commit. Anything else, including an
// API error, runs the Web regression as usual.
//
//   node .github/scripts/web-regression-reuse.mjs [--sha <commit>] [--repo <owner/name>]
//
// Reads GH_TOKEN (or GITHUB_TOKEN), GITHUB_REPOSITORY and GITHUB_SHA; prints the decision and, in
// Actions, writes reuse=true|false to GITHUB_OUTPUT. Always exits 0.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The name of the CI job whose result is reused; the workflow test keeps it equal to ci.yml. */
export const WEB_REGRESSION_JOB = 'Web regression';
const WORKFLOW = '.github/workflows/ci.yml';

/**
 * Decides for `sha` of `repository`, reading GitHub through `api(route)`, which returns the parsed
 * JSON of one REST route and throws on failure. Returns { reuse, reason, pull?, run? }.
 */
export async function reuseDecision({ repository, sha, api }) {
  try {
    const pulls = await api(`/repos/${repository}/commits/${sha}/pulls`);
    const pull = pulls.find((candidate) => candidate.base?.ref === 'main');
    if (!pull) return { reuse: false, reason: `no pull request into main contains ${sha}` };
    const head = pull.head.sha;
    const [pushed, last] = await Promise.all([sha, head].map((commit) => api(`/repos/${repository}/git/commits/${commit}`)));
    if (pushed.tree.sha !== last.tree.sha) {
      return { reuse: false, pull: pull.number, reason: `tree ${pushed.tree.sha} of ${sha} differs from tree ${last.tree.sha} of #${pull.number}'s last commit ${head}` };
    }
    const { workflow_runs: runs } = await api(`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request&per_page=100`);
    for (const run of runs.filter((candidate) => candidate.path === WORKFLOW)) {
      const { jobs } = await api(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`);
      if (jobs.some((job) => job.name === WEB_REGRESSION_JOB && job.conclusion === 'success')) {
        return { reuse: true, pull: pull.number, run: run.html_url,
          reason: `tree ${pushed.tree.sha} equals #${pull.number}'s last commit ${head}, whose Web regression passed in ${run.html_url}` };
      }
    }
    return { reuse: false, pull: pull.number, reason: `no successful ${WEB_REGRESSION_JOB} in a pull_request run of #${pull.number}'s last commit ${head}` };
  } catch (error) {
    return { reuse: false, reason: `cannot compare: ${error.message}` };
  }
}

/** A GitHub REST reader with `token`. */
export function githubApi(token) {
  return async (route) => {
    const response = await fetch(`https://api.github.com${route}`, { headers: {
      accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}),
    } });
    if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${response.statusText}`);
    return response.json();
  };
}

async function main() {
  const { values } = parseArgs({ options: { sha: { type: 'string' }, repo: { type: 'string' } } });
  const repository = values.repo ?? process.env.GITHUB_REPOSITORY;
  const sha = values.sha ?? process.env.GITHUB_SHA;
  const decision = repository && sha
    ? await reuseDecision({ repository, sha, api: githubApi(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN) })
    : { reuse: false, reason: 'needs --repo and --sha, or GITHUB_REPOSITORY and GITHUB_SHA' };
  console.log(decision.reuse ? `Web regression skipped: ${decision.reason}` : `Web regression runs: ${decision.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${decision.reuse}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

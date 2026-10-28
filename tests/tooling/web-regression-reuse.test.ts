// The decision whether a push to main reuses its pull request's Web regression, against a fake
// GitHub REST API.
import { describe, expect, it } from 'vitest';
import { reuseDecision, WEB_REGRESSION_JOB } from '../../.github/scripts/web-regression-reuse.mjs';

const repository = 'owner/repo';
const pushed = 'a'.repeat(40);
const head = 'b'.repeat(40);

type Routes = Record<string, unknown>;
const api = (routes: Routes) => async (route: string) => {
  if (!(route in routes)) throw new Error(`GET ${route}: 404 Not Found`);
  return routes[route];
};
const run = (id: number, path = '.github/workflows/ci.yml') => ({ id, path, html_url: `https://github.com/owner/repo/actions/runs/${id}` });
const routes = ({ pushedTree = 't1', headTree = 't1', runs = [run(7)], jobs = { 7: [{ name: WEB_REGRESSION_JOB, conclusion: 'success' }] } as Record<number, unknown[]> } = {}): Routes => ({
  [`/repos/${repository}/commits/${pushed}/pulls`]: [{ number: 171, base: { ref: 'main' }, head: { sha: head } }],
  [`/repos/${repository}/git/commits/${pushed}`]: { tree: { sha: pushedTree } },
  [`/repos/${repository}/git/commits/${head}`]: { tree: { sha: headTree } },
  [`/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request&per_page=100`]: { workflow_runs: runs },
  ...Object.fromEntries(Object.entries(jobs).map(([id, list]) => [`/repos/${repository}/actions/runs/${id}/jobs?per_page=100`, { jobs: list }])),
});
const decide = (fake: Routes) => reuseDecision({ repository, sha: pushed, api: api(fake) });

describe('Web regression reuse on main', () => {
  it('reuses the pull request run when the pushed tree equals its last commit and Web regression passed', async () => {
    const decision = await decide(routes());
    expect(decision).toMatchObject({ reuse: true, pull: 171, run: 'https://github.com/owner/repo/actions/runs/7' });
    expect(decision.reason).toContain('#171');
  });

  it('runs when the pushed tree differs from the pull request head', async () => {
    expect(await decide(routes({ pushedTree: 't2' }))).toMatchObject({ reuse: false, pull: 171, reason: expect.stringContaining('differs') });
  });

  it('runs when no pull request into main contains the commit', async () => {
    const fake = routes();
    fake[`/repos/${repository}/commits/${pushed}/pulls`] = [{ number: 9, base: { ref: 'release' }, head: { sha: head } }];
    expect(await decide(fake)).toMatchObject({ reuse: false, reason: expect.stringContaining('no pull request') });
  });

  it('runs when the pull request run has no successful Web regression', async () => {
    expect(await decide(routes({ runs: [] }))).toMatchObject({ reuse: false });
    expect(await decide(routes({ jobs: { 7: [{ name: WEB_REGRESSION_JOB, conclusion: 'failure' }] } }))).toMatchObject({ reuse: false });
    expect(await decide(routes({ jobs: { 7: [{ name: 'Verify', conclusion: 'success' }] } }))).toMatchObject({ reuse: false });
    expect(await decide(routes({ runs: [run(8, '.github/workflows/other.yml')], jobs: { 8: [{ name: WEB_REGRESSION_JOB, conclusion: 'success' }] } })))
      .toMatchObject({ reuse: false });
  });

  it('reuses an earlier successful attempt when the newest run of the commit failed', async () => {
    const decision = await decide(routes({ runs: [run(9), run(7)], jobs: {
      9: [{ name: WEB_REGRESSION_JOB, conclusion: 'cancelled' }], 7: [{ name: WEB_REGRESSION_JOB, conclusion: 'success' }],
    } }));
    expect(decision).toMatchObject({ reuse: true, run: 'https://github.com/owner/repo/actions/runs/7' });
  });

  it('runs when GitHub cannot be read', async () => {
    expect(await decide({})).toMatchObject({ reuse: false, reason: expect.stringContaining('cannot compare') });
  });
});

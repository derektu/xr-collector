#!/usr/bin/env node
// Reports one nightly run on the nightly issue: the open issue labelled `nightly`, or a new one.
// A failed run names its failed jobs, the flows and checks that failed (from the results.json files
// the jobs uploaded) and the run, on a new issue or as a comment on the open one; a new issue goes
// on the project board with Status Todo. A passing run comments on the open issue, which stays open
// until someone closes it with the fix.
//
// Run by the nightly workflow's report job. Environment: GH_TOKEN (issues), PROJECT_TOKEN (a token
// with the `project` scope on the user's project board; without it the issue says the board is not set),
// PROJECT_OWNER, PROJECT_NUMBER, RESULTS_DIR (the downloaded artifacts), RUN_ID, RUN_URL, REF_NAME, SHA,
// GITHUB_REPOSITORY.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LABEL = 'nightly';
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/** Runs gh with the given token and returns its standard output; a failure carries gh's own message. */
function gh(args, token = env('GH_TOKEN')) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${String(error.stderr ?? '').trim() || error.message}`);
  }
}

/** Runs one GraphQL request with the given token; strings go as -f and numbers as -F. */
function graphql(query, variables, token) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
  return JSON.parse(gh(args, token)).data;
}

/** The run's jobs that did not pass, by name; the report job itself is still running. */
function failedJobs() {
  const jobs = JSON.parse(gh(['api', `repos/${env('GITHUB_REPOSITORY')}/actions/runs/${env('RUN_ID')}/jobs?per_page=100`])).jobs;
  return jobs.filter((job) => job.status === 'completed' && !['success', 'skipped'].includes(job.conclusion))
    .map((job) => ({ name: job.name, conclusion: job.conclusion, url: job.html_url }));
}

/** Every results.json under the downloaded artifacts that did not pass, with its failed checks. */
function failedResults(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((file) => path.basename(file) === 'results.json').sort()
    .flatMap((file) => {
      let result;
      try { result = JSON.parse(readFileSync(path.join(dir, file), 'utf8')); } catch { return [{ file, unreadable: true, checks: [] }]; }
      if (result.passed) return [];
      const checks = (result.results ?? []).flatMap((scenario) => (scenario.checks ?? []).filter((check) => !check.ok)
        .map((check) => `${scenario.id} ${check.id ?? ''} ${check.text}`.replace(/\s+/gu, ' ').trim()));
      return [{ file, flow: result.flow ?? result.target?.kind ?? path.basename(path.dirname(file)), error: result.error ?? result.cleanupError ?? null, checks }];
    });
}

function failureText({ jobs, results }) {
  const lines = [`Nightly 在 \`${env('REF_NAME')}\`（${env('SHA').slice(0, 7)}）失敗：${env('RUN_URL')}`, '', '**失敗的 job**', ''];
  lines.push(...(jobs.length ? jobs.map((job) => `- [${job.name}](${job.url})：${job.conclusion}`) : ['- （沒有讀到失敗的 job）']));
  if (results.length) {
    lines.push('', '**失敗的流程**', '');
    for (const result of results) {
      lines.push(`- \`${result.file}\`（${result.flow}）${result.unreadable ? '：results.json 無法解析' : ''}`);
      if (result.error) lines.push(`  - ${String(result.error).split('\n')[0]}`);
      for (const check of result.checks.slice(0, 10)) lines.push(`  - ${check}`);
    }
  }
  lines.push('', '每支流程的 results.json 與失敗證據在這次 run 的 artifacts。修正 nightly 失敗優先於新功能。');
  return lines.join('\n');
}

/**
 * Puts the issue on the project board with Status Todo, then reads the board back. Returns the
 * Status the board shows, or throws with the reason. The board is a user's project, reached through
 * `user(login).projectV2` so a token with only the `project` scope can write it; `gh project` also
 * looks the owner up as an organization, which needs `read:org`.
 */
function addToBoard(number) {
  const token = env('PROJECT_TOKEN');
  const project = Number(env('PROJECT_NUMBER'));
  const [owner, repo] = env('GITHUB_REPOSITORY').split('/');
  const board = graphql(`query($owner: String!, $project: Int!) { user(login: $owner) { projectV2(number: $project) {
    id status: field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`,
  { owner: env('PROJECT_OWNER'), project }, token).user?.projectV2;
  if (!board) throw new Error(`project ${project} of ${env('PROJECT_OWNER')} not found`);
  const todo = board.status?.options?.find((option) => option.name === 'Todo');
  if (!todo) throw new Error('the board has no Status field with a Todo option');
  const issue = graphql('query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { id } } }',
    { owner, repo, number }, token).repository.issue;
  const item = graphql('mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }',
    { project: board.id, content: issue.id }, token).addProjectV2ItemById.item;
  graphql(`mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
  { project: board.id, item: item.id, field: board.status.id, option: todo.id }, token);
  const read = graphql(`query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) {
    projectItems(first: 20) { nodes { project { id } status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
  { owner, repo, number }, token);
  const shown = read.repository.issue.projectItems.nodes.find((node) => node.project.id === board.id)?.status?.name;
  if (shown !== 'Todo') throw new Error(`the board shows Status ${shown ?? 'nothing'} after the update`);
  return shown;
}

function main() {
  const repo = env('GITHUB_REPOSITORY');
  const jobs = failedJobs();
  const results = failedResults(env('RESULTS_DIR'));
  const open = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', LABEL, '--state', 'open', '--json', 'number,url', '--limit', '1']))[0];
  if (!jobs.length) {
    if (open) {
      gh(['issue', 'comment', String(open.number), '--repo', repo, '--body', `Nightly 在 \`${env('REF_NAME')}\`（${env('SHA').slice(0, 7)}）通過：${env('RUN_URL')}`]);
      console.log(`Passed; commented on #${open.number}.`);
    } else console.log('Passed; no open nightly issue.');
    return;
  }
  const body = failureText({ jobs, results });
  if (open) {
    gh(['issue', 'comment', String(open.number), '--repo', repo, '--body', body]);
    console.log(`Failed; commented on #${open.number} (${open.url}).`);
    return;
  }
  gh(['label', 'create', LABEL, '--repo', repo, '--color', 'B60205', '--description', 'Nightly build failures', '--force']);
  const url = gh(['issue', 'create', '--repo', repo, '--title', `Nightly 失敗：${new Date().toISOString().slice(0, 10)}`, '--label', LABEL, '--body', body]).trim();
  const number = Number(url.split('/').pop());
  console.log(`Failed; opened ${url}.`);
  try {
    if (!process.env.PROJECT_TOKEN) throw new Error('the NIGHTLY_PROJECT_TOKEN secret is not set');
    console.log(`Board status of #${number}: ${addToBoard(number)}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gh(['issue', 'comment', String(number), '--repo', repo, '--body', `issue 已建立，看板設定尚未完成：${reason}`]);
    console.error(`::warning::Issue opened, board not set: ${reason}`);
  }
}

main();

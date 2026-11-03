#!/usr/bin/env node
// Reports one nightly run on the nightly issue: the open issue labelled `nightly`, or a new one.
// A failed run names its failed jobs, the flows and checks that failed (from the results.json files
// the jobs uploaded) and the run, on a new issue or as a comment on the open one; a new issue goes
// on the project board with Status Todo. A passing run comments on the open issue, which stays open
// until someone closes it with the fix.
//
// Run by the nightly workflow's report job. Environment: GH_TOKEN (issues), PROJECT_TOKEN (a token
// that can write the user's project board; without it the issue says the board is not set),
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

/** Runs gh with the given token and returns its standard output. */
function gh(args, token = env('GH_TOKEN')) {
  return execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'pipe', 'inherit'] });
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
 * Status the board shows, or throws with the reason.
 */
function addToBoard(issueUrl, number) {
  const token = env('PROJECT_TOKEN');
  const owner = env('PROJECT_OWNER');
  const project = env('PROJECT_NUMBER');
  const item = JSON.parse(gh(['project', 'item-add', project, '--owner', owner, '--url', issueUrl, '--format', 'json'], token));
  const board = JSON.parse(gh(['project', 'view', project, '--owner', owner, '--format', 'json'], token));
  const status = JSON.parse(gh(['project', 'field-list', project, '--owner', owner, '--format', 'json'], token)).fields.find((field) => field.name === 'Status');
  const todo = status?.options?.find((option) => option.name === 'Todo');
  if (!todo) throw new Error('the board has no Status field with a Todo option');
  gh(['project', 'item-edit', '--id', item.id, '--project-id', board.id, '--field-id', status.id, '--single-select-option-id', todo.id], token);
  const [repoOwner, repo] = env('GITHUB_REPOSITORY').split('/');
  const query = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) {
    projectItems(first: 20) { nodes { project { number } status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
  const read = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${repoOwner}`, '-F', `repo=${repo}`, '-F', `number=${number}`], token));
  const shown = read.data.repository.issue.projectItems.nodes.find((node) => String(node.project.number) === project)?.status?.name;
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
    console.log(`Board status of #${number}: ${addToBoard(url, number)}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gh(['issue', 'comment', String(number), '--repo', repo, '--body', `issue 已建立，看板設定尚未完成：${reason}`]);
    console.error(`::warning::Issue opened, board not set: ${reason}`);
  }
}

main();

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubAdapter, promoteStableRelease, publishPrerelease, uploadDraftRelease, verifyAnonymousRelease, verifyRemoteRelease } from './github-release.mjs';
import { planReleaseCandidate, stageReleaseCandidate } from './release-candidate.mjs';
import { createStageTimer, runWithTimingReport } from './stage-timings.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseReleaseArguments(argv) {
  const action = argv[0];
  if (!['plan', 'stage', 'draft-upload', 'remote-verify', 'anonymous-verify', 'publish-prerelease', 'promote-stable'].includes(action)) throw new Error('Release action must be plan, stage, draft-upload, remote-verify, anonymous-verify, publish-prerelease, or promote-stable.');
  const options = { action };
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--input', '--acceptance', '--notes', '--output', '--stage', '--repo', '--authorization', '--source-base-url', '--version', '--tag'].includes(name)) throw new Error(`Unknown release argument ${name}.`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
    options[name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

/**
 * Runs one release action. Each stage's wall time is recorded; when the action ends, also on
 * failure, the timing table is printed to stderr and `release-<action>-timings-<time>.json` is
 * written next to the `--input` or `--stage` directory (inside neither, because both have an
 * exact file inventory).
 */
export async function runReleaseCommand(options, dependencies = {}) {
  const timer = dependencies.timer ?? createStageTimer();
  const report = { command: `release ${options.action}` };
  const describeRun = () => ({ file: releaseTimingReportPath(options, timer.origin, dependencies.timingReportDirectory), ...report });
  return runWithTimingReport(timer, describeRun, () => runReleaseAction(options, dependencies, timer, report), { log: dependencies.timingLog });
}

async function runReleaseAction(options, dependencies, timer, report) {
  if (options.action === 'plan' || options.action === 'stage') {
    for (const field of ['input', 'acceptance', 'notes', 'sourceBaseUrl']) if (!options[field]) throw new Error(`${options.action} requires --${field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}.`);
    const plan = await timer.group('plan', (child) => planReleaseCandidate(options, { ...dependencies, timer: child }));
    Object.assign(report, { version: plan.version, tag: plan.tag, commit: plan.commit, candidates: plan.candidates.map((candidate) => candidate.key),
      artifacts: plan.candidates.flatMap((candidate) => candidate.artifacts.map(({ basename, bytes, sha256 }) => ({ path: basename, bytes, sha256 }))) });
    if (options.action === 'plan') return { action: 'plan', version: plan.version, tag: plan.tag, commit: plan.commit, sourceBaseUrl: plan.sourceBaseUrl, candidates: plan.candidates.map((candidate) => candidate.key), scenarios: plan.acceptance.scenarios };
    if (!options.output) throw new Error('stage requires --output.');
    return timer.group('stage', (child) => stageReleaseCandidate(plan, options.output, child));
  }
  if (!options.stage) throw new Error(`${options.action} requires --stage.`);
  Object.assign(report, await readStagedIdentity(options.stage));
  if (options.action === 'anonymous-verify') return timer.group('anonymous verify', (child) => verifyAnonymousRelease(options.stage, dependencies.fetch ?? fetch, child));
  if (!options.repo) throw new Error(`${options.action} requires --repo.`);
  const adapter = dependencies.adapter ?? createGitHubAdapter(options.repo, dependencies);
  if (options.action === 'remote-verify') return timer.group('remote verify', (child) => verifyRemoteRelease(options.stage, adapter, { authenticated: true, timer: child }));
  assertPublishingHost(dependencies.platform ?? process.platform);
  if (!options.authorization) throw new Error(`${options.action} requires --authorization.`);
  const authorization = JSON.parse(await readFile(options.authorization, 'utf8'));
  if (options.action === 'draft-upload') return uploadDraftRelease(options.stage, adapter, authorization, timer);
  if (options.action === 'publish-prerelease') return publishPrerelease(options.stage, adapter, authorization, timer);
  return promoteStableRelease(options.stage, adapter, authorization, dependencies.fetch ?? fetch, timer);
}

export function releaseTimingReportPath(options, startedAt, directory) {
  const anchor = options.input ?? options.stage;
  const parent = directory ?? (anchor ? path.dirname(path.resolve(anchor)) : path.join(projectRoot, '.local/release-timings'));
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/gu, '-');
  return path.join(parent, `release-${options.action}-timings-${stamp}.json`);
}

/** Identity for the timing report only; the action itself still verifies the stage in full. */
async function readStagedIdentity(stageDirectory) {
  try {
    const state = JSON.parse(await readFile(path.join(stageDirectory, '.release-state.json'), 'utf8'));
    return { version: state.version, tag: state.tag, commit: state.commit,
      artifacts: Array.isArray(state.assets) ? state.assets.map(({ name, bytes, sha256 }) => ({ path: name, bytes, sha256 })) : undefined };
  } catch { return {}; }
}

export function assertPublishingHost(platform) {
  if (platform !== 'darwin') throw new Error('GitHub Release mutations must run from the authorized Mac publisher.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseCommand(parseReleaseArguments(process.argv.slice(2))).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

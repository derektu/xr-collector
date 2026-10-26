#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubAdapter, promoteStableRelease, publishPrerelease, uploadDraftRelease, verifyAnonymousRelease, verifyRemoteRelease } from './github-release.mjs';
import { planReleaseCandidate, stageReleaseCandidate } from './release-candidate.mjs';

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

export async function runReleaseCommand(options, dependencies = {}) {
  if (options.action === 'plan' || options.action === 'stage') {
    for (const field of ['input', 'acceptance', 'notes', 'sourceBaseUrl']) if (!options[field]) throw new Error(`${options.action} requires --${field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}.`);
    const plan = await planReleaseCandidate(options, dependencies);
    if (options.action === 'plan') return { action: 'plan', version: plan.version, tag: plan.tag, commit: plan.commit, sourceBaseUrl: plan.sourceBaseUrl, candidates: plan.candidates.map((candidate) => candidate.key), scenarios: plan.acceptance.scenarios };
    if (!options.output) throw new Error('stage requires --output.');
    return stageReleaseCandidate(plan, options.output);
  }
  if (!options.stage) throw new Error(`${options.action} requires --stage.`);
  if (options.action === 'anonymous-verify') return verifyAnonymousRelease(options.stage, dependencies.fetch ?? fetch);
  if (!options.repo) throw new Error(`${options.action} requires --repo.`);
  const adapter = dependencies.adapter ?? createGitHubAdapter(options.repo, dependencies);
  if (options.action === 'remote-verify') return verifyRemoteRelease(options.stage, adapter, { authenticated: true });
  assertPublishingHost(dependencies.platform ?? process.platform);
  if (!options.authorization) throw new Error(`${options.action} requires --authorization.`);
  const authorization = JSON.parse(await readFile(options.authorization, 'utf8'));
  if (options.action === 'draft-upload') return uploadDraftRelease(options.stage, adapter, authorization);
  if (options.action === 'publish-prerelease') return publishPrerelease(options.stage, adapter, authorization);
  return promoteStableRelease(options.stage, adapter, authorization, dependencies.fetch ?? fetch);
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

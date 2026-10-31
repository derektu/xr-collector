#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseIndexName } from './package-app.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = { darwin: 'darwin-arm64', win32: 'win32-x64' };

/** Stops the upload with a reason the person running it can act on. */
export class UploadStopped extends Error {}

/**
 * Uploads this machine's package for one platform to the draft GitHub Release of `tag`.
 * It checks that the checkout is the clean commit the package was built from and that the tag
 * points at it, creating the tag and the draft when they do not exist yet. Files already in the
 * draft with the same SHA-256 are skipped; a same-named file with other bytes stops the upload.
 * After uploading, every file is downloaded back and hashed. Each platform runs this on its own
 * build machine, in any order, against the same tag. Publishing the draft is left to
 * `gh release edit`.
 */
export async function uploadRelease({ tag }, dependencies = {}) {
  const root = dependencies.root ?? projectRoot;
  const outputDir = dependencies.outputDir ?? path.join(root, 'release');
  const exec = dependencies.exec ?? execute;
  const log = dependencies.log ?? console.log;
  const git = (args) => exec('git', args, { cwd: root });
  const gh = (args, options) => exec('gh', args, { cwd: root, ...options });
  const ghJson = async (args) => JSON.parse(await gh(args));

  const version = /^v(\d+\.\d+\.\d+)$/u.exec(tag ?? '')?.[1];
  if (!version) throw new UploadStopped(`Release tag must look like v0.1.0, got ${tag ?? 'nothing'}.`);
  const target = TARGETS[dependencies.platform ?? process.platform];
  if (!target) throw new UploadStopped('release:upload runs on the Mac or Windows build machine that built the package.');

  const indexPath = path.join(outputDir, releaseIndexName(target));
  const index = await readJson(indexPath, `${path.relative(root, indexPath)} is missing; run npm run package:${target === 'darwin-arm64' ? 'mac' : 'win'} first.`);
  if (index.version !== version || index.target !== target) {
    throw new UploadStopped(`${releaseIndexName(target)} is version ${index.version} for ${index.target}, not ${version} for ${target}.`);
  }
  const manifestPath = path.join(outputDir, `XR-Collector-${version}-${target}-artifacts.json`);
  const manifest = await readJson(manifestPath, `${path.relative(root, manifestPath)} is missing; package this version again.`);
  if (manifest.commit !== index.commit) throw new UploadStopped(`${path.basename(manifestPath)} and ${releaseIndexName(target)} come from different builds.`);
  const repository = manifest.packageIdentity?.updateRepository;
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new UploadStopped(`${path.basename(manifestPath)} names no update repository.`);

  if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).trim()) {
    throw new UploadStopped('The checkout has uncommitted changes. Upload from a clean checkout of the commit the package was built from.');
  }
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  if (head !== index.commit) throw new UploadStopped(`HEAD is ${head}, but the package was built from ${index.commit}. Check out that commit or package again.`);
  const localTag = await optional(() => git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]));
  if (localTag !== null && localTag.trim() !== head) throw new UploadStopped(`The local tag ${tag} points at ${localTag.trim()}, not HEAD ${head}.`);

  const files = await Promise.all([...new Set([index.installer.name, index.update.name])].map(async (name) => {
    const declared = [index.installer, index.update].find((entry) => entry.name === name);
    const filePath = path.join(outputDir, name);
    const actual = await describeFile(filePath).catch((error) => {
      if (error.code === 'ENOENT') throw new UploadStopped(`${name} is missing from ${path.relative(root, outputDir)}.`);
      throw error;
    });
    if (actual.bytes !== declared.bytes || actual.sha256 !== declared.sha256) {
      throw new UploadStopped(`${name} does not match ${releaseIndexName(target)} (SHA-256 ${actual.sha256}, index ${declared.sha256}).`);
    }
    return { name, filePath, ...actual };
  }));
  files.push({ name: releaseIndexName(target), filePath: indexPath, ...await describeFile(indexPath) });

  try { await gh(['auth', 'status', '--hostname', 'github.com']); }
  catch (error) {
    // gh auth status also fails when it cannot reach GitHub to check the token, so its own words are kept.
    throw new UploadStopped(`gh cannot use a github.com sign-in; run gh auth login if it is missing. ${error.message}`);
  }

  log(`Uploading ${target} ${version} (${head.slice(0, 12)}) to ${repository} ${tag}.`);
  const remoteTag = await optional(() => ghJson(['api', `repos/${repository}/git/ref/tags/${tag}`]));
  if (remoteTag) {
    const tagged = remoteTag.object.type === 'tag'
      ? (await ghJson(['api', `repos/${repository}/git/tags/${remoteTag.object.sha}`])).object.sha
      : remoteTag.object.sha;
    if (tagged !== head) throw new UploadStopped(`${repository} tag ${tag} points at ${tagged}, not HEAD ${head}.`);
  } else {
    // GitHub answers 422 for a commit it does not have.
    if (await optional(() => gh(['api', `repos/${repository}/commits/${head}`]), [404, 422]) === null) {
      throw new UploadStopped(`${repository} does not have commit ${head}. Push it before uploading.`);
    }
    await gh(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${head}`]);
    log(`Created tag ${tag} at ${head}.`);
  }

  const releases = (await ghJson(['api', `repos/${repository}/releases?per_page=100`])).filter((release) => release.tag_name === tag);
  if (releases.length > 1) throw new UploadStopped(`${repository} has ${releases.length} releases for ${tag}; delete the extra drafts in GitHub and run again.`);
  let release = releases[0];
  if (release && !release.draft) throw new UploadStopped(`${repository} ${tag} is already published; files are uploaded only to a draft.`);
  if (!release) {
    release = await ghJson(['api', '--method', 'POST', `repos/${repository}/releases`, '-f', `tag_name=${tag}`, '-f', `name=${tag}`, '-F', 'draft=true']);
    log(`Created draft release ${tag}.`);
  }

  const download = (asset) => gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${asset.id}`], { digest: true });
  const pending = [];
  for (const file of files) {
    const asset = release.assets?.find((entry) => entry.name === file.name);
    if (!asset) { pending.push(file); continue; }
    const remote = asset.state === 'uploaded' ? await download(asset) : null;
    if (remote?.sha256 !== file.sha256) {
      throw new UploadStopped(`The draft already has a different ${file.name}. Remove it with gh release delete-asset ${tag} ${file.name} --repo ${repository} if this build replaces it.`);
    }
    log(`  skip   ${file.name} (already uploaded, same SHA-256)`);
  }
  if (pending.length) {
    for (const file of pending) log(`  upload ${file.name} (${file.bytes} bytes)`);
    await gh(['release', 'upload', tag, ...pending.map((file) => file.filePath), '--repo', repository]);
  }

  const uploaded = await ghJson(['api', `repos/${repository}/releases/${release.id}`]);
  for (const file of files) {
    const asset = uploaded.assets?.find((entry) => entry.name === file.name);
    const remote = asset ? await download(asset) : null;
    if (remote?.sha256 !== file.sha256 || remote?.bytes !== file.bytes) {
      throw new UploadStopped(`${file.name} in the draft does not match the local file after upload.`);
    }
  }
  log(`Verified ${files.length} files in draft ${tag} by downloading them back.`);
  const names = new Set(uploaded.assets.map((asset) => asset.name));
  const platforms = Object.values(TARGETS).filter((entry) => names.has(releaseIndexName(entry)));
  log(`Platforms in the draft: ${platforms.join(', ')}.`);
  return { repository, tag, target, uploaded: pending.map((file) => file.name), skipped: files.filter((file) => !pending.includes(file)).map((file) => file.name), platforms };
}

async function readJson(filePath, missingMessage) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new UploadStopped(missingMessage); throw error; }
}

/** Resolves a lookup that GitHub answers with one of `statuses`, or Git with nothing found, to null. */
async function optional(lookup, statuses = [404]) {
  try { return await lookup(); }
  catch (error) { if (error.notFound || statuses.includes(error.status)) return null; throw error; }
}

async function describeFile(filePath) {
  const bytes = (await stat(filePath)).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Runs a command and resolves its stdout, or with `digest` the byte count and SHA-256 of its
 * stdout without holding it in memory. A failure carries the HTTP `status` gh reports, and
 * `notFound` when `git rev-parse --verify --quiet` finds nothing.
 */
export function execute(command, args, { cwd, digest = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256');
    let bytes = 0; let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (digest) { hash.update(chunk); bytes += chunk.length; } else stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => reject(error.code === 'ENOENT' ? new UploadStopped(`${command} is not installed or not on PATH.`) : error));
    child.once('close', (code) => {
      if (code === 0) { resolve(digest ? { bytes, sha256: hash.digest('hex') } : stdout); return; }
      const error = new Error(`${command} ${args.join(' ')} exited with ${code}: ${stderr.trim()}`);
      const status = /HTTP (\d{3})/u.exec(stderr)?.[1];
      if (status) error.status = Number(status);
      error.notFound = command === 'git' && args.includes('--verify') && code === 1;
      reject(error);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, ...rest] = process.argv.slice(2);
  if (rest.length) { console.error('Usage: npm run release:upload -- <tag>'); process.exit(2); }
  uploadRelease({ tag }).then(({ repository, tag: uploadedTag }) => {
    console.log(`Publish once every platform is in the draft: gh release edit ${uploadedTag} --repo ${repository} --draft=false --latest --notes-file <notes.md>`);
  }, (error) => {
    console.error(error instanceof UploadStopped ? `release:upload stopped: ${error.message}` : error);
    process.exit(1);
  });
}

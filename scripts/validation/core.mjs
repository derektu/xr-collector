import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const platforms = ['macos', 'windows'];
export const localPlatform = () => ({ darwin: 'macos', win32: 'windows' }[process.platform] ?? process.platform);
export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function readJson(file) { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
export function saveJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
export function safeId(value) {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) throw new Error('ID must use letters, digits, dash or underscore, and not be a Windows reserved name');
  return value;
}
export function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }).trimEnd();
}
export function repositoryId(remote) {
  const normalized = remote.trim().replace(/^git@([^:]+):/, 'https://$1/');
  try {
    const url = new URL(normalized.replace(/^ssh:\/\//, 'https://'));
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString().replace(/\.git\/?$/, '').replace(/\/$/, '');
  } catch {
    return `local-${digest(normalized)}`;
  }
}
export function validatePlan(plan) {
  if (!plan || !Number.isInteger(plan.version) || plan.version < 1 || !Array.isArray(plan.scenarios) || !plan.scenarios.length) throw new Error('Plan requires a positive version and scenarios');
  const ids = new Set();
  for (const s of plan.scenarios) {
    safeId(s.id);
    if (ids.has(s.id)) throw new Error(`Duplicate scenario: ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.platforms) || !s.platforms.length || new Set(s.platforms).size !== s.platforms.length || s.platforms.some(p => !['any', ...platforms].includes(p)) || (s.platforms.includes('any') && s.platforms.length !== 1)) throw new Error(`Invalid platforms: ${s.id}`);
    if (typeof s.reason !== 'string' || !s.reason.trim() || !Array.isArray(s.steps) || !s.steps.length || s.steps.some(x => typeof x !== 'string' || !x.trim()) || typeof s.expected !== 'string' || !s.expected.trim()) throw new Error(`Scenario requires reason, steps and expected result: ${s.id}`);
  }
  return plan;
}
export function planHash(plan) { return digest(canonical(validatePlan(plan))); }
export function applicable(scenario, platform) { return platforms.includes(platform) && (scenario.platforms.includes('any') || scenario.platforms.includes(platform)); }
export function snapshot(root) {
  const files = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const present = files.filter(f => existsSync(path.join(root, f)));
  // One Git process applies clean filters for all paths, including Windows CRLF normalization.
  const hashes = present.length ? git(root, ['hash-object', '--stdin-paths'], { input: present.map(f => JSON.stringify(f)).join('\n') + '\n' }).split('\n') : [];
  const byFile = new Map(present.map((f, i) => [f, hashes[i]]));
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(byFile.get(file) ?? 'deleted').update('\0');
  return { commit: git(root, ['rev-parse', 'HEAD']), status: git(root, ['status', '--porcelain']), sourceHash: hash.digest('hex') };
}
export function insideFile(root, relative) {
  if (path.isAbsolute(relative)) throw new Error('Evidence path must be relative');
  const file = path.resolve(root, relative);
  const prefix = realpathSync(root) + path.sep;
  if (!file.startsWith(path.resolve(root) + path.sep) || lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(prefix) || !lstatSync(file).isFile()) throw new Error('Evidence must be a regular file inside evidence directory');
  return file;
}
export function checkPng(file) {
  const data = readFileSync(file);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot must be a PNG');
  return digest(data);
}
export function summarize(plan, identity, reports) {
  validatePlan(plan);
  const expected = planHash(plan);
  for (const r of reports) {
    if (r.schema !== 1 || typeof r.provisional !== 'boolean' || r.repository !== identity.repository || r.commit !== identity.commit || r.planHash !== expected || !platforms.includes(r.platform)) throw new Error('Evidence repository, commit, plan or platform does not match');
    if (!Array.isArray(r.results)) throw new Error('Invalid evidence results');
    for (const result of r.results) {
      const scenario = plan.scenarios.find(s => s.id === result.scenario);
      if (!scenario || !applicable(scenario, r.platform) || !['pass','fail','blocked'].includes(result.result)) throw new Error('Invalid scenario result for platform');
      if (result.result === 'pass' && (!result.screenshots?.length || !result.note?.trim())) throw new Error('Pass requires screenshot evidence and observation');
    }
  }
  const scenarios = plan.scenarios.map(s => {
    const required = s.platforms.includes('any') ? ['any'] : s.platforms;
    const checks = required.map(p => {
      const matching = reports.filter(r => !r.provisional && (p === 'any' || r.platform === p)).flatMap(r => r.results.filter(x => x.scenario === s.id));
      // Conflicting supplied results are not silently overridden by a passing run.
      const status = matching.some(r => r.result === 'fail') ? 'fail' : matching.some(r => r.result === 'pass') ? 'pass' : 'pending';
      return { platform: p, status };
    });
    return { id: s.id, checks };
  });
  return { repository: identity.repository, commit: identity.commit, planHash: expected, complete: scenarios.every(s => s.checks.every(c => c.status === 'pass')), scenarios, provisionalReports: reports.filter(r => r.provisional).length };
}

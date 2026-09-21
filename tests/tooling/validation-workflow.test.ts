import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { applicable, validatePlan, planHash, summarize, repositoryId, snapshot, insideFile, digest } from '../../scripts/validation/core.mjs';

const roots: string[] = [];
function temp() { const p = mkdtempSync(path.join(tmpdir(), 'xr-validation-test-')); roots.push(p); return p; }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const scenario = (id: string, platforms: string[]) => ({ id, platforms, reason: 'test requirement', steps: ['operate native window'], expected: 'visible expected state' });
const plan = { version: 1, scenarios: [scenario('COMMON', ['any']), scenario('WIN', ['windows']), scenario('BOTH', ['macos', 'windows'])] };
const identity = { repository: 'https://github.com/example/collector', commit: 'a'.repeat(40) };
function report(platform: string, ids: string[], overrides = {}) {
  return { schema: 1, ...identity, planHash: planHash(plan), platform, provisional: false,
    results: ids.map(id => ({ scenario: id, result: 'pass', note: 'observed expected window', screenshots: [{ path: 'screenshots/window.png', sha256: 'b'.repeat(64) }] })), ...overrides };
}
describe('portable validation requirements', () => {
  it('lets a Windows developer complete common cases without requiring a Mac', () => {
    const commonPlan = { version: 1, scenarios: [scenario('COMMON', ['any'])] };
    expect(summarize(commonPlan, identity, [report('windows', ['COMMON'], { planHash: planHash(commonPlan) })]).complete).toBe(true);
    expect(applicable(scenario('MAC', ['macos']), 'windows')).toBe(false);
  });
  it('requires the missing platform even when all locally applicable cases pass', () => {
    const result = summarize(plan, identity, [report('windows', ['COMMON', 'WIN', 'BOTH'])]);
    expect(result.complete).toBe(false);
    expect(result.scenarios.find(s => s.id === 'BOTH')?.checks).toContainEqual({ platform: 'macos', status: 'pending' });
    expect(summarize(plan, identity, [report('windows', ['COMMON', 'WIN', 'BOTH']), report('macos', ['BOTH'])]).complete).toBe(true);
  });
  it('rejects results for a different commit, repository, plan or unsupported platform', () => {
    for (const override of [{ commit: 'c'.repeat(40) }, { repository: 'other' }, { planHash: 'wrong' }, { platform: 'linux' }, { provisional: undefined }]) {
      expect(() => summarize(plan, identity, [report('windows', ['WIN'], override)])).toThrow('does not match');
    }
    expect(() => summarize(plan, identity, [report('macos', ['WIN'])])).toThrow('platform');
  });
  it('does not count provisional, blocked or conflicting failing results as completion', () => {
    const complete = report('windows', ['COMMON', 'WIN', 'BOTH']);
    expect(summarize(plan, identity, [complete, report('macos', ['BOTH'], { provisional: true })]).complete).toBe(false);
    expect(summarize(plan, identity, [complete, report('macos', ['BOTH'], { results: [{ scenario: 'BOTH', result: 'blocked', note: 'locked desktop', screenshots: [] }] })]).complete).toBe(false);
    expect(summarize(plan, identity, [complete, report('macos', ['BOTH']), report('macos', [], { results: [{ scenario: 'BOTH', result: 'fail', note: 'regression', screenshots: [] }] })]).complete).toBe(false);
  });
  it('rejects an unobserved pass, ambiguous platforms and duplicate scenarios', () => {
    expect(() => summarize(plan, identity, [report('windows', [], { results: [{ scenario: 'WIN', result: 'pass', note: 'ok', screenshots: [] }] })])).toThrow('screenshot');
    expect(() => validatePlan({ version: 1, scenarios: [scenario('A', ['any', 'windows'])] })).toThrow('platforms');
    expect(() => validatePlan({ version: 1, scenarios: [scenario('A', ['any']), scenario('A', ['macos'])] })).toThrow('Duplicate');
  });
  it('normalizes SSH/HTTPS repository identity and canonicalizes plan object key order', () => {
    expect(repositoryId('git@github.com:example/collector.git')).toBe(identity.repository);
    expect(repositoryId('https://user:secret@github.com/example/collector.git')).toBe(identity.repository);
    expect(repositoryId('ssh://git@github.com/example/collector.git')).toBe(identity.repository);
    expect(planHash({ scenarios: plan.scenarios, version: 1 })).toBe(planHash(plan));
  });
  it('refuses outside and symlinked evidence', () => {
    const p = temp(); const evidence = path.join(p, 'evidence'); mkdirSync(evidence);
    writeFileSync(path.join(p, 'secret.png'), 'secret');
    expect(() => insideFile(evidence, '../secret.png')).toThrow();
    const outside = path.join(p, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'x.png'), 'secret');
    symlinkSync(outside, path.join(evidence, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => insideFile(evidence, 'link/x.png')).toThrow();
  });
});

it.skipIf(!['darwin','win32'].includes(process.platform))('creates an isolated worktree in a custom path while preserving dirty development files', () => {
  const p = temp(); const repo = path.join(p, 'developer checkout'); mkdirSync(repo);
  cpSync(path.resolve('scripts'), path.join(repo, 'scripts'), { recursive: true });
  writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init','-b','main'); git('config','user.name','Validation Test'); git('config','user.email','validation@example.invalid');
  git('config','core.autocrlf','false'); git('remote','add','origin',identity.repository); git('add','.'); git('commit','-m','fixture');
  const commit = git('rev-parse','HEAD');
  writeFileSync(path.join(repo, 'tracked.txt'), 'developer changes\n');
  writeFileSync(path.join(repo, 'untracked.txt'), 'developer new file\n');
  const planFile = path.join(p, 'plan.json'); writeFileSync(planFile, JSON.stringify(plan));
  const root = path.join(p, 'custom validation root');
  const launch = (...extra: string[]) => spawnSync(process.execPath, [path.join(repo, 'scripts/validation.mjs'), 'prepare', '--commit', commit, '--plan', planFile, '--root', root, '--run', 'preview', '--skip-install', ...extra], { encoding: 'utf8', timeout: 60000 });
  const before = snapshot(repo);
  const result = launch('--allow-dirty'); expect(result.status, result.stderr).toBe(0);
  const prepared = JSON.parse(result.stdout);
  expect(prepared.provisional).toBe(true);
  expect(prepared.workspace.startsWith(root)).toBe(true);
  expect(snapshot(path.join(prepared.workspace, 'checkout')).sourceHash).toBe(before.sourceHash);
  expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('developer changes\n');
  expect(snapshot(repo)).toEqual(before);
  expect(launch('--allow-dirty').status).not.toBe(0);
  const clean = spawnSync(process.execPath, [path.join(repo, 'scripts/validation.mjs'), 'prepare', '--commit', commit, '--plan', planFile, '--root', root, '--run', 'committed', '--skip-install'], { encoding: 'utf8', timeout: 60000 });
  expect(clean.status, clean.stderr).toBe(0);
  const cleanPrepared = JSON.parse(clean.stdout);
  expect(cleanPrepared.provisional).toBe(false);
  expect(readFileSync(path.join(cleanPrepared.workspace,'checkout/tracked.txt'),'utf8')).toBe('committed\n');
  const evidence = path.join(cleanPrepared.workspace, 'evidence');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8YQAAAAASUVORK5CYII=', 'base64');
  const screenshot = 'screenshots/COMMON.png';
  writeFileSync(path.join(evidence, screenshot), png);
  writeFileSync(path.join(evidence, screenshot + '.json'), JSON.stringify({ scenario: 'COMMON', sourceHash: cleanPrepared.sourceHash, sha256: digest(png) }));
  mkdirSync(path.join(cleanPrepared.workspace, 'state/profile'));
  writeFileSync(path.join(cleanPrepared.workspace, 'state/profile/agent-connection.json'), '{"token":"DO-NOT-EXPORT"}');
  writeFileSync(path.join(evidence, 'private.log'), 'DO-NOT-EXPORT');
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(repo, 'scripts/validation.mjs'), ...args], { encoding: 'utf8' });
  const record = cli('record', '--workspace', cleanPrepared.workspace, '--scenario', 'COMMON', '--result', 'pass', '--note', 'synthetic test screenshot', '--screenshot', screenshot);
  expect(record.status, record.stderr).toBe(0);
  const out = path.join(p, 'portable evidence');
  const exported = cli('export', '--workspace', cleanPrepared.workspace, '--output', out);
  expect(exported.status, exported.stderr).toBe(0);
  expect(readdirSync(out).sort()).toEqual(['plan.json','report.json','screenshots']);
  expect(readFileSync(path.join(out, 'report.json'),'utf8')).not.toContain('DO-NOT-EXPORT');
  expect(readFileSync(path.join(out, 'screenshots/COMMON.png'))).toEqual(png);
  const summary = cli('summarize', '--plan', planFile, '--commit', commit, '--bundle', out);
  expect(summary.status).toBe(2); // Missing platform cases must remain pending.
  writeFileSync(path.join(out, screenshot), Buffer.concat([png, Buffer.from('tampered')]));
  expect(cli('summarize', '--plan', planFile, '--commit', commit, '--bundle', out).status).toBe(1);

}, 120000);

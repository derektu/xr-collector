import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, cpSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { git, snapshot, readJson, saveJson, digest, safeId, repositoryId, validatePlan, planHash, applicable, localPlatform, insideFile, checkPng, summarize } from './validation/core.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptRoot, '..');
const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, workspace: { type: 'string' }, plan: { type: 'string' }, commit: { type: 'string' },
  pr: { type: 'string' }, remote: { type: 'string' }, run: { type: 'string' },
  'allow-dirty': { type: 'boolean' }, 'skip-install': { type: 'boolean' }, 'runtime-cache': { type: 'string' },
  scenario: { type: 'string' }, result: { type: 'string' }, note: { type: 'string' },
  file: { type: 'string' }, window: { type: 'string' }, output: { type: 'string' },
  bundle: { type: 'string', multiple: true }, screenshot: { type: 'string', multiple: true }, help: { type: 'boolean' },
} });
const command = positionals[0];
function requireValue(name) { if (!v[name]) throw new Error(`Missing --${name}`); return v[name]; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function native(file, args) { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function runNode(args, cwd = repo) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(new Error(`Command failed (${code})`)));
  });
}
function doctor() {
  const platform = localPlatform();
  const nodeSupported = process.versions.node.split('.').map(Number)[0] >= 22 && (Number(process.versions.node.split('.')[0]) > 22 || Number(process.versions.node.split('.')[1]) >= 12);
  const supported = nodeSupported && ((platform === 'macos' && process.arch === 'arm64') || (platform === 'windows' && process.arch === 'x64'));
  let gitAvailable = false;
  try { native('git', ['--version']); gitAvailable = true; } catch {}
  return { platform, osRelease: os.release(), nodeArchitecture: process.arch, nodeVersion: process.version, runtimeSupported: supported, gitAvailable,
    desktop: 'Requires an unlocked interactive user session; capture validates access at execution time',
    readyToPrepare: supported && gitAvailable, note: 'Current runtimes: Mac arm64 or Windows x64 Node, including x64 emulation on ARM Windows. Parallels is optional.' };
}
function workspace() {
  const directory = path.resolve(requireValue('workspace'));
  const config = readJson(path.join(directory, 'workspace.json'));
  if (config.schema !== 1 || config.platform !== localPlatform()) throw new Error('Workspace belongs to another platform; prepare a new workspace on this machine');
  const checkout = path.join(directory, 'checkout');
  const plan = validatePlan(readJson(path.join(directory, 'plan.json')));
  if (planHash(plan) !== config.planHash) throw new Error('Plan changed; prepare a new run');
  const actual = snapshot(checkout);
  if (actual.commit !== config.commit || actual.sourceHash !== config.sourceHash || (actual.status && !config.provisional)) throw new Error('Checkout changed; prepare a new run for this revision');
  return { directory, config, checkout, plan, state: path.join(directory, 'state'), evidence: path.join(directory, 'evidence') };
}
function sourceCurrent(w) {
  const current = readJson(path.join(w.state, 'current.json'));
  if (current.commit !== w.config.commit || current.sourceHash !== w.config.sourceHash || !alive(current.pid)) throw new Error('No running application for this revision');
  return current;
}
function scenario(w) {
  const s = w.plan.scenarios.find(x => x.id === requireValue('scenario'));
  if (!s || !applicable(s, w.config.platform)) throw new Error('This scenario requires another platform; it remains pending');
  return s;
}
async function prepare() {
  const caps = doctor();
  if (!caps.readyToPrepare) throw new Error(JSON.stringify(caps));
  const commit = requireValue('commit');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Use the full 40-character commit SHA');
  const plan = validatePlan(readJson(path.resolve(requireValue('plan'))));
  const remotes = git(repo, ['remote']).split('\n');
  const remote = v.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
  if (!remote || !remotes.includes(remote)) throw new Error('Select a configured Git remote with --remote');
  const repository = repositoryId(git(repo, ['remote', 'get-url', remote]));
  if (v.pr) {
    if (!/^[1-9][0-9]*$/.test(v.pr)) throw new Error('Invalid PR number');
    git(repo, ['fetch', remote, `refs/pull/${v.pr}/head`]);
    if (git(repo, ['rev-parse', 'FETCH_HEAD']) !== commit) throw new Error('PR HEAD changed or does not match --commit');
  } else {
    try { git(repo, ['cat-file', '-e', `${commit}^{commit}`]); } catch { git(repo, ['fetch', remote, commit]); }
  }
  const before = snapshot(repo);
  if (v['allow-dirty'] && before.commit !== commit) throw new Error('Dirty preview requires the current HEAD');
  const id = safeId(v.run ?? `run-${Date.now()}`);
  const root = path.resolve(v.root ?? process.env.XR_COLLECTOR_VALIDATION_ROOT ?? path.join(os.homedir(), '.xr-collector', 'validation'));
  const relativeRoot = path.relative(repo, root);
  if (!relativeRoot || (!relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== '..' && !path.isAbsolute(relativeRoot))) throw new Error('Validation root must be outside the development checkout');
  const directory = path.join(root, `repo-${digest(repository).slice(0, 12)}`, v.pr ? `pr-${v.pr}` : 'commit', commit, caps.platform, id);
  if (existsSync(directory)) throw new Error('Run directory already exists; reuse start/status or choose another --run');
  mkdirSync(directory, { recursive: true });
  const checkout = path.join(directory, 'checkout');
  git(repo, ['worktree', 'add', '--detach', checkout, commit]);
  if (v['allow-dirty']) {
    const patch = git(repo, ['diff', '--binary', 'HEAD']);
    if (patch) git(checkout, ['apply', '--binary', '-'], { input: patch + '\n' });
    for (const name of git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      const from = path.join(repo, name);
      if (!lstatSync(from).isFile() || lstatSync(from).isSymbolicLink()) throw new Error(`Dirty preview requires regular untracked files: ${name}`);
      const to = path.join(checkout, name); mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to);
    }
    if (snapshot(repo).sourceHash !== before.sourceHash || snapshot(checkout).sourceHash !== before.sourceHash) throw new Error('Source changed while preparing; discard this incomplete run and retry');
  }
  const source = snapshot(checkout);
  const state = path.join(directory, 'state'); const evidence = path.join(directory, 'evidence');
  mkdirSync(state); mkdirSync(evidence); mkdirSync(path.join(evidence, 'screenshots'));
  saveJson(path.join(directory, 'plan.json'), plan);
  const config = { schema: 1, repository, commit, pr: v.pr ?? null, planHash: planHash(plan), platform: caps.platform,
    run: id, sourceHash: source.sourceHash, provisional: Boolean(source.status), createdAt: new Date().toISOString(), prepared: false };
  saveJson(path.join(directory, 'workspace.json'), config);
  if (v['runtime-cache']) cpSync(path.resolve(v['runtime-cache']), path.join(checkout, 'resources', 'bin'), { recursive: true, dereference: true });
  if (!v['skip-install']) {
    if (!process.env.npm_execpath) throw new Error('Invoke through npm run validation');
    await runNode([process.env.npm_execpath, 'ci'], checkout);
    // Some npm installations omit dependency install scripts. Ensure Electron exists explicitly.
    await runNode([path.join(checkout, 'node_modules/electron/install.js')], checkout);
    const electron = path.join(checkout, 'node_modules/electron/dist', caps.platform === 'windows' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron');
    if (!existsSync(electron)) throw new Error('Electron binary missing; check download configuration before starting a new run');
    config.prepared = true; saveJson(path.join(directory, 'workspace.json'), config);
  }
  console.log(JSON.stringify({ workspace: directory, ...config, localScenarios: plan.scenarios.filter(s => applicable(s, caps.platform)).map(s => s.id),
    remainingPlatforms: [...new Set(plan.scenarios.flatMap(s => s.platforms).filter(p => p !== 'any' && p !== caps.platform))] }, null, 2));
}
async function main() {
  if (v.help || !command) {
    console.log(`npm run validation -- <command> [options]
  doctor
  prepare --plan <json> --commit <full SHA> [--pr <number>] [--root <path>] [--run <id>]
          [--allow-dirty] [--runtime-cache <bin directory>] [--skip-install]
  start|status|stop --workspace <path>
  capture --workspace <path> --scenario <id> [--window <Mac window ID> | --file <native PNG>]
  record --workspace <path> --scenario <id> --result pass|fail|blocked --note <observation> [--screenshot <relative PNG>]...
  export --workspace <path> --output <new directory>
  summarize --plan <json> --commit <SHA> --bundle <export directory> [--bundle <another directory>]...
Start is local to the current interactive desktop. No Parallels installation is required.`);
    return;
  }
  if (command === 'doctor') { const result = doctor(); console.log(JSON.stringify(result, null, 2)); if (!result.readyToPrepare) process.exitCode = 2; return; }
  if (command === 'prepare') return prepare();
  if (command === 'summarize') {
    const plan = validatePlan(readJson(requireValue('plan')));
    if (!v.bundle?.length) throw new Error('Supply --bundle');
    const reports = v.bundle.map(b => {
      const r = readJson(path.join(b, 'report.json'));
      for (const result of r.results ?? []) for (const shot of result.screenshots ?? []) {
        if (checkPng(insideFile(b, shot.path)) !== shot.sha256) throw new Error('Screenshot checksum mismatch');
      }
      return r;
    });
    const remotes = git(repo, ['remote']).split('\n'); const remote = v.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
    const result = summarize(plan, { repository: repositoryId(git(repo, ['remote', 'get-url', remote])), commit: requireValue('commit') }, reports);
    console.log(JSON.stringify(result, null, 2)); if (!result.complete) process.exitCode = 2; return;
  }
  const w = workspace();
  if (command === 'start' || command === 'status') {
    if (command === 'start' && !w.config.prepared) throw new Error('Prepare used --skip-install; create a prepared run before starting');
    return runNode([path.join(scriptRoot, 'desktop-validation.mjs'), '--checkout', w.checkout, '--directory', w.state,
      '--evidence-root', path.join(w.evidence, 'sessions'), '--run', w.config.run, ...(command === 'status' ? ['--status'] : ['--commit', w.config.commit]), ...(w.config.provisional ? ['--allow-dirty'] : [])]);
  }
  if (command === 'stop') {
    const current = readJson(path.join(w.state, 'current.json'));
    if (!alive(current.pid)) { console.log('Already stopped; state and evidence preserved.'); return; }
    if (process.platform === 'win32') native('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptRoot, 'validation/windows-ui.ps1'), '-Action', 'Stop', '-ProcessId', String(current.pid), '-Checkout', w.checkout, '-CreatedAt', current.createdAt]);
    else {
      const actual = native('ps', ['-p', String(current.pid), '-o', 'comm=']).trim();
      if (actual !== path.join(w.checkout, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')) throw new Error('Process identity changed; inspect before stopping');
      native('osascript', ['-e', `tell application "System Events" to tell (first application process whose unix id is ${Number(current.pid)})`, '-e', 'set frontmost to true', '-e', 'keystroke "q" using command down', '-e', 'end tell']);
    }
    for (let n = 0; n < 60 && alive(current.pid); n++) await new Promise(r => setTimeout(r, 1000));
    if (alive(current.pid)) throw new Error('Application still running; close this window normally and retry');
    console.log('Stopped; state and evidence preserved.'); return;
  }
  if (command === 'capture') {
    const s = scenario(w); const current = sourceCurrent(w);
    const relative = `screenshots/${s.id}-${Date.now()}.png`; const output = path.join(w.evidence, relative);
    if (v.file) { checkPng(v.file); copyFileSync(v.file, output); }
    else if (process.platform === 'darwin') {
      if (!v.window || !/^[1-9][0-9]*$/.test(v.window)) throw new Error('Supply the actual application --window ID or --file from a native screenshot tool');
      native('screencapture', ['-x', '-l', v.window, output]);
    } else native('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptRoot, 'validation/windows-ui.ps1'), '-Action', 'Capture', '-ProcessId', String(current.pid), '-Checkout', w.checkout, '-CreatedAt', current.createdAt, '-Output', output]);
    const sha256 = checkPng(output);
    saveJson(output + '.json', { scenario: s.id, path: relative, sha256, source: v.file ? 'imported-native-screenshot' : 'native-capture', pid: current.pid, capturedAt: new Date().toISOString(), sourceHash: current.sourceHash });
    console.log(relative); return;
  }
  if (command === 'record') {
    const s = scenario(w);
    if (!['pass','fail','blocked'].includes(v.result) || !v.note?.trim()) throw new Error('Supply --result pass|fail|blocked and --note');
    const screenshots = (v.screenshot ?? []).map(relative => {
      const file = insideFile(w.evidence, relative); const metadata = readJson(file + '.json');
      if (metadata.scenario !== s.id || metadata.sourceHash !== w.config.sourceHash || checkPng(file) !== metadata.sha256) throw new Error('Screenshot does not match this scenario/revision');
      return { path: relative.replaceAll('\\', '/'), sha256: metadata.sha256 };
    });
    if (v.result === 'pass' && !screenshots.length) throw new Error('Pass requires an inspected native screenshot');
    const file = path.join(w.evidence, 'results.json'); const results = existsSync(file) ? readJson(file) : [];
    if (results.some(r => r.scenario === s.id)) throw new Error('Scenario already recorded; use a new run for a different outcome');
    results.push({ scenario: s.id, result: v.result, note: v.note, screenshots, recordedAt: new Date().toISOString() }); saveJson(file, results); return;
  }
  if (command === 'export') {
    const output = path.resolve(requireValue('output'));
    if (existsSync(output)) throw new Error('Export destination must be new');
    const results = existsSync(path.join(w.evidence, 'results.json')) ? readJson(path.join(w.evidence, 'results.json')) : [];
    mkdirSync(output, { recursive: true });
    for (const result of results) for (const shot of result.screenshots) {
      const source = insideFile(w.evidence, shot.path); if (checkPng(source) !== shot.sha256) throw new Error('Screenshot changed');
      const destination = path.join(output, shot.path); mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(source, destination);
    }
    let environment = null;
    if (existsSync(path.join(w.state, 'current.json'))) {
      const c = readJson(path.join(w.state, 'current.json'));
      environment = { osRelease: c.osRelease, hostArchitecture: c.hostArchitecture, nodeArchitecture: c.nodeArchitecture, nodeVersion: c.nodeVersion };
    }
    const report = { ...w.config, environment, results }; delete report.prepared;
    saveJson(path.join(output, 'report.json'), report); saveJson(path.join(output, 'plan.json'), w.plan);
    console.log(`Exported report and explicitly recorded screenshots to ${output}. Profile, Vault, connection files and logs excluded.`); return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

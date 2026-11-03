#!/usr/bin/env node
// Command line around the verify library: start, seed, capture, read and stop one Web-mode instance,
// run the recorded flows, and check evidence against the code. Ticket flows import lib/index.mjs for
// everything else. Run from the checkout under test:
//   node .claude/skills/verify/scripts/verify.mjs <command> [options]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkEvidence, resultFiles } from './lib/check.mjs';
import { attach, launchWeb, stopRun } from './lib/instance.mjs';
import { checkoutRoot, evidenceDir } from './lib/paths.mjs';
import { waitFor } from './lib/wait.mjs';
import { collect, idle, subscribe } from './lib/seed.mjs';
import { findFeature, readFeatures } from './lib/features.mjs';
import { apiState, readState } from './lib/state.mjs';
import { REAL } from './lib/synthetic.mjs';
// Playwright takes about a second of CPU to load, so only the commands that use it load it: snapshot
// and flows.

const USAGE = `verify.mjs <command>
  launch   --issue <N> [--label <name>] [--evidence <dir>] [--data synthetic|real] [--vault selected|fixed|none] [--checkout <dir>]
           builds the checkout's Web UI into a new run and starts it; evidence goes to a new folder
           .local/ticket-artifacts/<N>/[<label>-]<local time>/ of the worktree the command runs in, which the
           output's evidence names; --evidence <dir> writes it there instead (a missing or empty folder);
           --checkout picks the version under test
  state    --run <dir>                         the run's data: api, vault, profile and index side by side; read-only
  seed     --run <dir> [--collect <url>]... [--subscribe <url>]... [--wait]
  snapshot --run <dir> --name <name> [--route /documents] [--theme dark|light]
  stop     --run <dir> [--keep]                stop one instance; --keep leaves profile and Vault for inspection
  flows list [--feature <file>]
           the recorded regression flows and the feature-map sub-features each covers
  flows run [<flow>...] --issue <N> [--label <name>] [--checkout <dir>] [--web|--desktop] [--visible] [--feature <file>] [--jobs <N>]
           runs the named recorded flows (all without names), each on its own instance; --web is every
           flow that is not Desktop (what the nightly runs on a Mac); Desktop flows keep their window hidden,
           and --visible runs the Desktop flows whose visibleScenarios need a window on screen, with
           the window shown, so those checks run too; --feature keeps the flows covering a
           sub-feature of that feature file (subscriptions or subscriptions.md); --jobs runs up to N at
           once (default 1, at most one per verify slot; a Desktop flow always runs alone); the flows and
           this library come from the checkout the command runs in, --checkout picks the checkout under
           test; evidence goes to a new folder .local/ticket-artifacts/<N>/<label>-<local time>/<flow>/
           (label defaults to flows); exit code 1 when any flow fails
  check    [--issue <N>] [--platform darwin|win32]... [--scenario <ID>]... [<results.json or folder>...]
           whether the evidence proves the code as it is now: results.json files (those of issue N's
           evidence, and of the folders given) count while their checkout still has the recorded commit
           and uncommitted changes, or, from another machine, when they tested this commit from a clean
           checkout; complete when every scenario passed on every given platform (any one platform
           without --platform); --scenario names a scenario the flow must record; exit code 2 when not
           complete`;

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  issue: { type: 'string' }, label: { type: 'string' }, evidence: { type: 'string' }, data: { type: 'string', default: 'synthetic' }, vault: { type: 'string', default: 'selected' },
  checkout: { type: 'string' }, run: { type: 'string' }, keep: { type: 'boolean' },
  collect: { type: 'string', multiple: true }, subscribe: { type: 'string', multiple: true }, wait: { type: 'boolean' },
  name: { type: 'string' }, route: { type: 'string', default: '/' }, theme: { type: 'string', default: 'dark' }, help: { type: 'boolean' },
  platform: { type: 'string', multiple: true }, scenario: { type: 'string', multiple: true },
  web: { type: 'boolean' }, desktop: { type: 'boolean' }, visible: { type: 'boolean' }, jobs: { type: 'string', default: '1' }, feature: { type: 'string' },
} });
const print = (value) => console.log(JSON.stringify(value, null, 2));
const need = (name) => { if (!o[name]) throw new Error(`Missing --${name}\n${USAGE}`); return o[name]; };

async function snapshot() {
  const { openPage, painted } = await import('./lib/drive.mjs');
  const instance = attach(need('run'));
  const name = need('name');
  const { page, close } = await openPage(instance, { route: o.route, colorScheme: o.theme });
  // The screen has read the server (`data-revision`) or shows Onboarding, its fonts are loaded and its styles drawn.
  await waitFor(() => page.evaluate(() => Boolean(document.documentElement.dataset.revision || document.querySelector('.onboarding-screen'))), 'the screen read the server');
  await page.evaluate(() => document.fonts.ready);
  await painted(page);
  await mkdir(instance.evidence, { recursive: true });
  const png = path.join(instance.evidence, `${name}.png`);
  await page.screenshot({ path: png });
  await close();
  const state = path.join(instance.evidence, `${name}.state.json`);
  await writeFile(state, JSON.stringify({ commit: instance.commit, dirty: instance.dirty, sourceHash: instance.sourceHash, route: o.route, takenAt: new Date().toISOString(), ...(await apiState(instance)) }, null, 2));
  print({ screenshot: png, state });
}

function check() {
  const platforms = o.platform ?? [];
  if (platforms.some((platform) => !['darwin', 'win32'].includes(platform))) throw new Error(`--platform is darwin or win32\n${USAGE}`);
  const paths = [...(o.issue ? [evidenceDir(o.issue)] : []), ...positionals.slice(1)];
  if (!paths.length) throw new Error(`check needs --issue or results.json files\n${USAGE}`);
  const report = checkEvidence(resultFiles(paths), { checkout: checkoutRoot(), platforms, scenarios: o.scenario ?? [] });
  print(report);
  if (!report.complete) process.exitCode = 2;
}

async function main() {
  const command = positionals[0];
  if (o.help || !command) { console.log(USAGE); return; }
  if (command === 'launch') {
    if (!['synthetic', 'real'].includes(o.data) || !['selected', 'fixed', 'none'].includes(o.vault)) throw new Error(USAGE);
    const instance = await launchWeb({ issue: need('issue'), label: o.label, evidence: o.evidence, checkout: o.checkout, data: o.data, vault: o.vault });
    const { api, catalog, updateCatalog, restart, state, stop, ...record } = instance;
    if (o.data === 'real') record.real = REAL;
    return print(record);
  }
  if (command === 'state') return print(await readState(need('run')));
  if (command === 'seed') {
    const instance = attach(need('run'));
    const submitted = [];
    for (const url of o.subscribe ?? []) submitted.push({ subscribe: url, result: await subscribe(instance, url) });
    for (const url of o.collect ?? []) submitted.push({ collect: url, result: await collect(instance, url) });
    const overview = o.wait ? await idle(instance) : undefined;
    return print({ submitted, ...(overview ? { failed: overview.failed } : {}) });
  }
  if (command === 'snapshot') return snapshot();
  if (command === 'stop') return print(await stopRun(need('run'), { keep: o.keep }));
  if (command === 'check') return check();
  if (command === 'flows') {
    const { listFlows, runFlows, selectFlows } = await import('./lib/flows.mjs');
    if (positionals[1] === 'list') {
      const listed = selectFlows(await listFlows(), { feature: o.feature === undefined ? undefined : findFeature(readFeatures(), o.feature) });
      return print(listed.map(({ name, title, covers, desktop, visibleScenarios }) => ({ name, title, covers,
        ...(desktop ? { desktop } : {}), ...(visibleScenarios.length ? { visibleScenarios } : {}) })));
    }
    if (positionals[1] !== 'run') throw new Error(`flows needs list or run\n${USAGE}`);
    if (o.web && o.desktop) throw new Error('Choose only one of --web or --desktop');
    const outcome = await runFlows({ names: positionals.slice(2), issue: need('issue'), label: o.label, checkout: o.checkout,
      layer: o.web ? 'web' : o.desktop ? 'desktop' : 'all', feature: o.feature, jobs: /^\d+$/u.test(o.jobs) ? Number(o.jobs) : Number.NaN,
      visible: o.visible === true });
    print(outcome);
    if (!outcome.flows.every((flow) => flow.passed)) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command ${command}\n${USAGE}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

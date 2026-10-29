// Recorded regression flows: the flows under ../../flows/ that every ticket touching their features
// runs. A flow and this library always come from the checkout the command runs in; --checkout picks
// only the src/ under test, so a baseline on main and the ticket's version run the same assertions,
// and a checkout without flows/ can still be the baseline.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPage, recorder } from './drive.mjs';
import { launchElectron } from './electron.mjs';
import { writeFailureResult } from './failure.mjs';
import { findFeature, readFeatures } from './features.mjs';
import { launchWeb } from './instance.mjs';
import { checkoutRoot, claimEvidence, commitOf, SLOTS } from './paths.mjs';
import { apiState } from './state.mjs';
import { sleep, waitFor } from './wait.mjs';

export const FLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'flows');

/**
 * The tier of a flow says when it is worth its cost: `core` the common paths and data safety, run
 * for quick local feedback; `feature` one feature's edges, run when a ticket touches that feature;
 * `platform` Desktop and packaging, run when the platform layer changes; `real` real sources over
 * the network, run before delivering collection changes. A pull request's CI runs every Web flow
 * (`--web`) whatever its tier.
 */
export const TIERS = ['core', 'feature', 'platform', 'real'];

/** Seconds one flow may take in CI; a flow that needs longer exports `overBudget` with the reason. */
export const FLOW_BUDGET_SECONDS = 60;

/** Seconds every Web flow together may take in CI with --jobs 3. */
export const WEB_BUDGET_SECONDS = 300;

/** Every recorded flow: { name, title, tier, covers, desktop, overBudget, run, file }, by name. */
export async function listFlows(dir = FLOWS_DIR) {
  const files = readdirSync(dir).filter((file) => file.endsWith('.mjs')).sort();
  return Promise.all(files.map(async (file) => {
    const flow = await import(pathToFileURL(path.join(dir, file)).href);
    if (!flow.name || !flow.title || !Array.isArray(flow.covers) || typeof flow.run !== 'function') {
      throw new Error(`${file} must export name, title, tier, covers and run`);
    }
    if (!TIERS.includes(flow.tier)) throw new Error(`${file} must export tier, one of ${TIERS.join(', ')}; got ${flow.tier}`);
    if (flow.desktop === true && flow.tier !== 'platform') throw new Error(`${file} is a Desktop flow, so its tier is platform; got ${flow.tier}`);
    if (flow.overBudget !== undefined && (typeof flow.overBudget !== 'string' || !flow.overBudget.trim())) {
      throw new Error(`${file} overBudget must say why the flow needs more than ${FLOW_BUDGET_SECONDS}s`);
    }
    return { name: flow.name, title: flow.title, tier: flow.tier, covers: flow.covers, desktop: flow.desktop === true, catalog: flow.catalog,
      vault: flow.vault === 'none' ? 'none' : 'selected', overBudget: flow.overBudget, run: flow.run, file: path.join(dir, file) };
  }));
}

/**
 * The flows to run, in their listed order. `names` picks flows by name (strict); `layer` is `web`
 * (every flow that is neither Desktop nor real-source: the set CI runs), `desktop` or `all`; `tier`
 * keeps one tier; `feature` (a parsed feature file) keeps the flows covering any of its sub-features.
 */
export function selectFlows(flows, { names = [], layer = 'all', tier, feature } = {}) {
  if (!['all', 'web', 'desktop'].includes(layer)) throw new Error(`Unknown flow layer ${layer}`);
  if (tier !== undefined && !TIERS.includes(tier)) throw new Error(`Unknown tier ${tier}; known: ${TIERS.join(', ')}`);
  const unknown = names.filter((name) => !flows.some((flow) => flow.name === name));
  if (unknown.length) throw new Error(`Unknown flow ${unknown.join(', ')}; known: ${flows.map((flow) => flow.name).join(', ')}`);
  const inLayer = (flow) => layer === 'all' || (layer === 'desktop' ? flow.desktop : !flow.desktop && flow.tier !== 'real');
  return flows.filter((flow) => (names.length === 0 || names.includes(flow.name))
    && inLayer(flow)
    && (tier === undefined || flow.tier === tier)
    && (feature === undefined || flow.covers.some((id) => feature.subFeatures.includes(id))));
}

/**
 * The waiting flows to start next, in their listed order: at most `jobs` run at once, and a Desktop
 * flow runs alone, because it shows its window and uses the machine's one tray and login items. A
 * Desktop flow waits for every running flow to end, and the flows after it wait for it.
 */
export function startable(waiting, running, jobs) {
  const started = [];
  for (const flow of waiting) {
    const busy = [...running, ...started];
    if (busy.length >= jobs || busy.some((other) => other.desktop)) break;
    if (flow.desktop) {
      if (busy.length === 0) started.push(flow);
      break;
    }
    started.push(flow);
  }
  return started;
}

/**
 * Runs every flow through `runOne`, keeping as many running as `startable` allows, and returns their
 * outcomes in the flows' order. A flow that throws becomes a failed outcome; the others carry on.
 */
export async function runPool(flows, jobs, runOne) {
  const waiting = [...flows];
  const running = new Set();
  const outcomes = new Map();
  await new Promise((resolve) => {
    const fill = () => {
      if (!waiting.length && !running.size) { resolve(); return; }
      for (const flow of startable(waiting, [...running], jobs)) {
        waiting.splice(waiting.indexOf(flow), 1);
        running.add(flow);
        Promise.resolve().then(() => runOne(flow))
          .catch((error) => ({ name: flow.name, passed: false, error: error.message }))
          .then((outcome) => {
            outcomes.set(flow, outcome);
            running.delete(flow);
            fill();
          });
      }
    };
    fill();
  });
  return flows.map((flow) => outcomes.get(flow));
}

/** The flow whose work is running, so log lines of flows running side by side say which flow wrote them. */
const currentFlow = new AsyncLocalStorage();

/**
 * Runs the flows `selectFlows` picks (all when nothing narrows them; `feature` names a feature file
 * of the map) against `checkout`, up to `jobs` at once, each on its own instance and slot. The label (default `flows`) names one evidence folder for this whole
 * invocation, `<label>/`, `<label>-2/`… as launch does; each flow writes into `<label folder>/<flow>/`.
 * With more than one job, each log line starts with `[<flow>]`. Prints a table of each flow's
 * timings at the end. Returns { evidence, label, jobs, wallMs, flows: [{ name, passed, evidence, timings, error? }] }.
 */
export async function runFlows({ names = [], issue, label = 'flows', checkout = checkoutRoot(), layer = 'all', tier, feature, jobs = 1 } = {}) {
  if (!issue) throw new Error('flows run needs --issue for the evidence folder');
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > SLOTS.length) throw new Error(`--jobs is a whole number from 1 to ${SLOTS.length}, one verify slot per flow`);
  const all = await listFlows();
  const selected = selectFlows(all, { names, layer, tier, feature: feature === undefined ? undefined : findFeature(readFeatures(), feature) });
  if (!selected.length) throw new Error(`No flows selected (layer ${layer}${tier ? `, tier ${tier}` : ''}${feature ? `, feature ${feature}` : ''})`);
  const claimed = claimEvidence(issue, label);
  const source = flowSource();
  const log = console.log;
  if (jobs > 1) console.log = (...args) => { const name = currentFlow.getStore(); return name ? log(`[${name}]`, ...args) : log(...args); };
  const started = performance.now();
  let outcomes;
  try {
    outcomes = await runPool(selected, jobs, (flow) => currentFlow.run(flow.name, () => {
      console.log(`flow ${flow.name}: ${flow.title}`);
      return runOne(flow, { issue, label: claimed.label, evidence: path.join(claimed.evidence, flow.name), checkout, source });
    }).then((outcome) => ({ ...outcome, tier: flow.tier, ...(flow.overBudget ? { overBudget: flow.overBudget } : {}) })));
  } finally {
    console.log = log;
  }
  const wallMs = Math.round(performance.now() - started);
  console.log(timingTable(outcomes, { jobs, wallMs }));
  return { evidence: claimed.evidence, label: claimed.label, jobs, wallMs, flows: outcomes };
}

/** A flow's prepare, run and cleanup milliseconds added up; undefined when none was measured. */
export function totalMs(timings = {}) {
  const { prepareMs, runMs, cleanupMs } = timings;
  return [prepareMs, runMs, cleanupMs].some((ms) => typeof ms === 'number') ? (prepareMs ?? 0) + (runMs ?? 0) + (cleanupMs ?? 0) : undefined;
}

/**
 * The end-of-run table: each flow's result, tier, and its prepare, run, cleanup and total seconds.
 * A flow over the one-flow budget is marked, with whether it declares why; the last line says when
 * the wall clock is over the budget for every Web flow.
 */
export function timingTable(outcomes, { jobs, wallMs }) {
  const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '-');
  const rows = outcomes.map((outcome) => {
    const { prepareMs, runMs, cleanupMs } = outcome.timings ?? {};
    const total = totalMs(outcome.timings);
    const budget = total !== undefined && total > FLOW_BUDGET_SECONDS * 1000
      ? (outcome.overBudget ? `over ${FLOW_BUDGET_SECONDS}s (declared)` : `over ${FLOW_BUDGET_SECONDS}s, no overBudget`) : '';
    return [outcome.name, outcome.passed ? 'PASSED' : 'FAILED', outcome.tier ?? '-', seconds(prepareMs), seconds(runMs), seconds(cleanupMs), seconds(total), budget];
  });
  const table = [['flow', 'result', 'tier', 'prepare', 'run', 'cleanup', 'total', 'budget'], ...rows];
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
  const right = (column) => column >= 3 && column <= 6;
  const lines = table.map((row) => row.map((cell, column) => (right(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ').trimEnd());
  const wall = `${outcomes.length} flows in ${seconds(wallMs)} with --jobs ${jobs}`;
  return [...lines, wallMs > WEB_BUDGET_SECONDS * 1000 ? `${wall}; over the ${WEB_BUDGET_SECONDS}s budget for every Web flow` : wall].join('\n');
}

/** Milliseconds spent in each phase of one flow: `mark(phase)` closes the phase that began at the previous mark. */
function phaseClock() {
  let last = performance.now();
  const timings = {};
  return { timings, mark(phase) { const now = performance.now(); timings[`${phase}Ms`] = Math.round(now - last); last = now; } };
}

/** Adds the flow's timings to its results.json, which the recorder or a failure result wrote before cleanup ended. */
async function recordTimings(evidence, timings) {
  const file = path.join(evidence, 'results.json');
  if (!existsSync(file)) return;
  const result = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...result, timings }, null, 2));
}

/** Writes the result of a failure before a Web instance and recorder could be created. */
export async function writeProvisioningFailure({ issue, label, evidence, checkout, flow, source, error, phase = 'provisioning' }) {
  return writeFailureResult({ evidence, error, phase, record: {
    issue: String(issue), label, checkout, ...commitOf(checkout), data: 'synthetic',
    layer: 'Web 模式（headless Chromium）', flow, flowSource: source,
  } });
}

/** The checkout the flows came from, recorded in each results.json beside the checkout under test. */
function flowSource() {
  const checkout = checkoutRoot(path.dirname(FLOWS_DIR));
  return { checkout, ...commitOf(checkout) };
}

async function runOne(flow, options) {
  if (flow.desktop) return runDesktop(flow, options);
  const { issue, label, evidence, checkout, source } = options;
  const clock = phaseClock();
  let instance;
  try {
    // The flow, driver and verification server are one harness revision; only product src comes
    // from --checkout. This lets a candidate CI harness repeatedly test a clean main revision.
    instance = await launchWeb({ issue, label, evidence, checkout, vault: flow.vault, data: flow.tier === 'real' ? 'real' : 'synthetic',
      ...(typeof flow.catalog === 'function' ? { catalog: flow.catalog() } : {}),
      server: path.resolve(FLOWS_DIR, '..', 'scripts', 'server.mts') });
  } catch (error) {
    // Provisioning can fail before a recorder exists (runtime, browser or server startup). Keep a
    // machine-readable result in the same allowlisted evidence tree instead of leaving only a log.
    clock.mark('prepare');
    await writeProvisioningFailure({ issue, label, evidence, checkout, flow: flow.name, source, error });
    await recordTimings(evidence, clock.timings);
    console.log(`FAILED ${flow.name}; provisioning evidence in ${evidence}`);
    return { name: flow.name, passed: false, evidence, timings: clock.timings, error: error.message };
  }
  clock.mark('prepare');
  const pages = [];
  const open = async (route = '/') => {
    const opened = await openPage(instance, { route });
    pages.push(opened);
    return opened.page;
  };
  let record;
  let error;
  try {
    const page = await open('/');
    record = recorder(instance, page);
    await flow.run({ instance, page, openPage: open, record, waitFor, sleep });
  } catch (caught) {
    error = caught;
    console.log(`  flow ${flow.name} stopped: ${caught.message}`);
  }
  let passed = false;
  try {
    const consoleErrors = pages.flatMap((opened) => opened.consoleErrors);
    const state = await apiState(instance).catch((caught) => ({ unavailable: caught.message }));
    if (record) passed = await record.finish({ flow: flow.name, flowSource: source, consoleErrors, state, ...(error ? { error: error.message } : {}) });
    else if (error) await writeProvisioningFailure({ issue, label, evidence, checkout, flow: flow.name, source, error, phase: 'browser' });
    clock.mark('run');
    for (const opened of pages) await opened.close().catch(() => undefined);
  } finally {
    // The server and its slot lock never outlive the flow, even when writing results.json fails.
    await instance.stop();
  }
  clock.mark('cleanup');
  await recordTimings(evidence, clock.timings);
  console.log(`${passed && !error ? 'PASSED' : 'FAILED'} ${flow.name}; evidence in ${evidence}`);
  return { name: flow.name, passed: passed && !error, evidence, timings: clock.timings, ...(error ? { error: error.message } : {}) };
}

/**
 * A Desktop flow (`export const desktop = true`) drives the development Electron of `checkout` with
 * its window shown, because it tests the window and the tray themselves. It gets the app handle as
 * `instance`, whose `api()` reaches the app's own API, and the window as `page`.
 */
async function runDesktop(flow, { issue, label, evidence, checkout, source }) {
  const clock = phaseClock();
  const instance = await launchElectron({ issue, label, evidence, checkout, hidden: false });
  clock.mark('prepare');
  const record = recorder(instance, () => instance.window);
  let error;
  try {
    await flow.run({ instance, page: instance.window, record, waitFor, sleep });
  } catch (caught) {
    error = caught;
    console.log(`  flow ${flow.name} stopped: ${caught.message}`);
  }
  let passed = false;
  try {
    const state = await apiState(instance).catch((caught) => ({ unavailable: caught.message }));
    passed = await record.finish({ flow: flow.name, flowSource: source, state, ...(error ? { error: error.message } : {}) });
    clock.mark('run');
  } finally {
    await instance.close({ keep: false }).catch((caught) => { error ??= caught; });
  }
  clock.mark('cleanup');
  await recordTimings(evidence, clock.timings);
  console.log(`${passed && !error ? 'PASSED' : 'FAILED'} ${flow.name}; evidence in ${evidence}`);
  return { name: flow.name, passed: passed && !error, evidence, timings: clock.timings, ...(error ? { error: error.message } : {}) };
}

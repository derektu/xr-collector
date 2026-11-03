// Recorded regression flows: the flows under ../../flows/ that every ticket touching their features
// runs. A flow and this library always come from the checkout the command runs in; --checkout picks
// the checkout under test, whose src/, Web build and verification server the flow drives.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync } from 'node:fs';
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
 * Every recorded flow: { name, title, covers, desktop, visibleScenarios, catalog, vault, run, file },
 * by name. `visibleScenarios` names the scenarios of a Desktop flow with checks that need its window
 * on screen; the rest of the flow runs with the window hidden.
 */
export async function listFlows(dir = FLOWS_DIR) {
  const files = readdirSync(dir).filter((file) => file.endsWith('.mjs')).sort();
  return Promise.all(files.map(async (file) => {
    const flow = await import(pathToFileURL(path.join(dir, file)).href);
    if (!flow.name || !flow.title || !Array.isArray(flow.covers) || typeof flow.run !== 'function') {
      throw new Error(`${file} must export name, title, covers and run`);
    }
    return { name: flow.name, title: flow.title, covers: flow.covers, desktop: flow.desktop === true,
      visibleScenarios: Array.isArray(flow.visibleScenarios) ? flow.visibleScenarios : [], catalog: flow.catalog,
      vault: flow.vault === 'none' ? 'none' : 'selected', run: flow.run, file: path.join(dir, file) };
  }));
}

/**
 * The flows to run, in their listed order. `names` picks flows by name (strict); `layer` is `web`
 * (every flow that is not Desktop: the set the E2E workflow runs), `desktop` or `all`; `feature` (a
 * parsed feature file) keeps the flows covering any of its sub-features; `visible` keeps the Desktop
 * flows with scenarios that need a window on screen.
 */
export function selectFlows(flows, { names = [], layer = 'all', feature, visible = false } = {}) {
  if (!['all', 'web', 'desktop'].includes(layer)) throw new Error(`Unknown flow layer ${layer}`);
  if (visible && layer === 'web') throw new Error('--visible runs Desktop flows; it cannot be combined with --web');
  const unknown = names.filter((name) => !flows.some((flow) => flow.name === name));
  if (unknown.length) throw new Error(`Unknown flow ${unknown.join(', ')}; known: ${flows.map((flow) => flow.name).join(', ')}`);
  const inLayer = (flow) => layer === 'all' || (layer === 'desktop') === flow.desktop;
  return flows.filter((flow) => (names.length === 0 || names.includes(flow.name))
    && inLayer(flow)
    && (!visible || (flow.desktop && flow.visibleScenarios.length > 0))
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
 * of the map) against `checkout`, up to `jobs` at once, each on its own instance and slot. Desktop
 * flows run with their window hidden; `visible` runs the Desktop flows that have scenarios needing
 * a window on screen, with the window shown, so those checks run too. The label
 * (default `flows`) names one new evidence folder for this whole invocation, as launch does; each flow
 * writes into `<that folder>/<flow>/`. With more than one job, each log line starts with `[<flow>]`.
 * Returns { evidence, label, jobs, flows: [{ name, passed, evidence, error? }] }.
 */
export async function runFlows({ names = [], issue, label = 'flows', checkout = checkoutRoot(), layer = 'all', feature, jobs = 1, visible = false } = {}) {
  if (!issue) throw new Error('flows run needs --issue for the evidence folder');
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > SLOTS.length) throw new Error(`--jobs is a whole number from 1 to ${SLOTS.length}, one verify slot per flow`);
  const all = await listFlows();
  const selected = selectFlows(all, { names, layer, visible, feature: feature === undefined ? undefined : findFeature(readFeatures(), feature) });
  if (!selected.length) throw new Error(`No flows selected (layer ${layer}${feature ? `, feature ${feature}` : ''})`);
  const claimed = claimEvidence(issue, label);
  const log = console.log;
  if (jobs > 1) console.log = (...args) => { const name = currentFlow.getStore(); return name ? log(`[${name}]`, ...args) : log(...args); };
  let outcomes;
  try {
    outcomes = await runPool(selected, jobs, (flow) => currentFlow.run(flow.name, () => {
      console.log(`flow ${flow.name}: ${flow.title}`);
      return runOne(flow, { issue, label: claimed.label, evidence: path.join(claimed.evidence, flow.name), checkout, visible });
    }));
  } finally {
    console.log = log;
  }
  const failed = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.name);
  console.log(`${outcomes.length - failed.length} of ${outcomes.length} flows passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  return { evidence: claimed.evidence, label: claimed.label, jobs, flows: outcomes };
}

/** Writes the result of a failure before a Web instance and recorder could be created. */
export async function writeProvisioningFailure({ issue, label, evidence, checkout, flow, error, phase = 'provisioning' }) {
  return writeFailureResult({ evidence, error, phase, record: {
    issue: String(issue), label, checkout, ...commitOf(checkout), data: 'synthetic',
    layer: 'Web 模式（headless Chromium）', flow,
  } });
}

async function runOne(flow, options) {
  if (flow.desktop) return runDesktop(flow, options);
  const { issue, label, evidence, checkout } = options;
  let instance;
  try {
    instance = await launchWeb({ issue, label, evidence, checkout, vault: flow.vault,
      ...(typeof flow.catalog === 'function' ? { catalog: flow.catalog() } : {}) });
  } catch (error) {
    // Provisioning can fail before a recorder exists (runtime, browser or server startup). Keep a
    // machine-readable result in the same evidence tree instead of leaving only a log.
    await writeProvisioningFailure({ issue, label, evidence, checkout, flow: flow.name, error });
    console.log(`FAILED ${flow.name}; provisioning evidence in ${evidence}`);
    return { name: flow.name, passed: false, evidence, error: error.message };
  }
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
    if (record) passed = await record.finish({ flow: flow.name, consoleErrors, state, ...(error ? { error: error.message } : {}) });
    else if (error) await writeProvisioningFailure({ issue, label, evidence, checkout, flow: flow.name, error, phase: 'browser' });
    for (const opened of pages) await opened.close().catch(() => undefined);
  } finally {
    // The server and its slot lock never outlive the flow, even when writing results.json fails.
    await instance.stop();
  }
  console.log(`${passed && !error ? 'PASSED' : 'FAILED'} ${flow.name}; evidence in ${evidence}`);
  return { name: flow.name, passed: passed && !error, evidence, ...(error ? { error: error.message } : {}) };
}

/**
 * A Desktop flow (`export const desktop = true`) drives the development Electron of `checkout`,
 * because it tests the window and the tray themselves. It gets the app handle as `instance`, whose
 * `api()` reaches the app's own API, the window as `page`, and `visible`: false while the window
 * stays hidden, when the flow skips the checks of its `visibleScenarios` that need it on screen.
 */
async function runDesktop(flow, { issue, label, evidence, checkout, visible = false }) {
  const instance = await launchElectron({ issue, label, evidence, checkout, hidden: !visible });
  const record = recorder(instance, () => instance.window);
  let error;
  try {
    await flow.run({ instance, page: instance.window, record, waitFor, sleep, visible });
  } catch (caught) {
    error = caught;
    console.log(`  flow ${flow.name} stopped: ${caught.message}`);
  }
  let passed = false;
  try {
    const state = await apiState(instance).catch((caught) => ({ unavailable: caught.message }));
    passed = await record.finish({ flow: flow.name, state, ...(error ? { error: error.message } : {}) });
  } finally {
    await instance.close({ keep: false }).catch((caught) => { error ??= caught; });
  }
  console.log(`${passed && !error ? 'PASSED' : 'FAILED'} ${flow.name}; evidence in ${evidence}`);
  return { name: flow.name, passed: passed && !error, evidence, ...(error ? { error: error.message } : {}) };
}

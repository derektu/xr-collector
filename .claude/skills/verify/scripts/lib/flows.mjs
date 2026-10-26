// Recorded regression flows: the flows under ../../flows/ that every ticket touching their features
// runs. A flow and this library always come from the checkout the command runs in; --checkout picks
// only the src/ under test, so a baseline on main and the ticket's version run the same assertions,
// and a checkout without flows/ can still be the baseline.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPage, recorder } from './drive.mjs';
import { launchElectron } from './electron.mjs';
import { writeFailureResult } from './failure.mjs';
import { launchWeb } from './instance.mjs';
import { checkoutRoot, claimEvidence, commitOf } from './paths.mjs';
import { apiState } from './state.mjs';
import { sleep, waitFor } from './wait.mjs';

export const FLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'flows');

/** Every recorded flow: { name, title, covers, run, file }, by name. */
export async function listFlows(dir = FLOWS_DIR) {
  const files = readdirSync(dir).filter((file) => file.endsWith('.mjs')).sort();
  return Promise.all(files.map(async (file) => {
    const flow = await import(pathToFileURL(path.join(dir, file)).href);
    if (!flow.name || !flow.title || !Array.isArray(flow.covers) || typeof flow.run !== 'function') {
      throw new Error(`${file} must export name, title, covers and run`);
    }
    return { name: flow.name, title: flow.title, covers: flow.covers, desktop: flow.desktop === true,
      vault: flow.vault === 'none' ? 'none' : 'selected', run: flow.run, file: path.join(dir, file) };
  }));
}

/**
 * Runs the named flows (all when `names` is empty) against `checkout`. The label (default `flows`)
 * names one evidence folder for this whole invocation, `<label>/`, `<label>-2/`… as launch does;
 * each flow launches its own instance and writes into `<label folder>/<flow>/`. Returns
 * { evidence, label, flows: [{ name, passed, evidence, error? }] }.
 */
export function selectFlows(flows, { names = [], layer = 'all' } = {}) {
  if (!['all', 'web', 'desktop'].includes(layer)) throw new Error(`Unknown flow layer ${layer}`);
  const unknown = names.filter((name) => !flows.some((flow) => flow.name === name));
  if (unknown.length) throw new Error(`Unknown flow ${unknown.join(', ')}; known: ${flows.map((flow) => flow.name).join(', ')}`);
  return flows.filter((flow) => (names.length === 0 || names.includes(flow.name))
    && (layer === 'all' || (layer === 'desktop') === flow.desktop));
}

export async function runFlows({ names = [], issue, label = 'flows', checkout = checkoutRoot(), layer = 'all' } = {}) {
  if (!issue) throw new Error('flows run needs --issue for the evidence folder');
  const all = await listFlows();
  const selected = selectFlows(all, { names, layer });
  if (!selected.length) throw new Error(`No ${layer} flows selected`);
  const claimed = claimEvidence(issue, label);
  const source = flowSource();
  const outcomes = [];
  for (const flow of selected) {
    console.log(`flow ${flow.name}: ${flow.title}`);
    outcomes.push(await runOne(flow, { issue, label: claimed.label, evidence: path.join(claimed.evidence, flow.name), checkout, source }));
  }
  return { evidence: claimed.evidence, label: claimed.label, flows: outcomes };
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
  let instance;
  try {
    // The flow, driver and verification server are one harness revision; only product src comes
    // from --checkout. This lets a candidate CI harness repeatedly test a clean main revision.
    instance = await launchWeb({ issue, label, evidence, checkout, vault: flow.vault,
      server: path.resolve(FLOWS_DIR, '..', 'scripts', 'server.mts') });
  } catch (error) {
    // Provisioning can fail before a recorder exists (runtime, browser or server startup). Keep a
    // machine-readable result in the same allowlisted evidence tree instead of leaving only a log.
    await writeProvisioningFailure({ issue, label, evidence, checkout, flow: flow.name, source, error });
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
    if (record) passed = await record.finish({ flow: flow.name, flowSource: source, consoleErrors, state, ...(error ? { error: error.message } : {}) });
    else if (error) await writeProvisioningFailure({ issue, label, evidence, checkout, flow: flow.name, source, error, phase: 'browser' });
    for (const opened of pages) await opened.close().catch(() => undefined);
  } finally {
    // The server and its slot lock never outlive the flow, even when writing results.json fails.
    await instance.stop();
  }
  console.log(`${passed && !error ? 'PASSED' : 'FAILED'} ${flow.name}; evidence in ${evidence}`);
  return { name: flow.name, passed: passed && !error, evidence, ...(error ? { error: error.message } : {}) };
}

/**
 * A Desktop flow (`export const desktop = true`) drives the development Electron of `checkout` with
 * its window shown, because it tests the window and the tray themselves. It gets the app handle as
 * `instance`, whose `api()` reaches the app's own API, and the window as `page`.
 */
async function runDesktop(flow, { issue, label, evidence, checkout, source }) {
  const instance = await launchElectron({ issue, label, evidence, checkout, hidden: false });
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
  } finally {
    await instance.close({ keep: false }).catch((caught) => { error ??= caught; });
  }
  console.log(`${passed && !error ? 'PASSED' : 'FAILED'} ${flow.name}; evidence in ${evidence}`);
  return { name: flow.name, passed: passed && !error, evidence, ...(error ? { error: error.message } : {}) };
}

// The record of each recorded flow across many runs: how often it failed, why, and how long it took.
// CI keeps every Web regression's results.json; the periodic review of the flows reads them through
// `flows history` to decide which flows to keep, merge or move to a lower tier.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FLOW_BUDGET_SECONDS, totalMs } from './flows.mjs';

/** Why one flow run failed: the run's error, else its failed checks as `<scenario>: <check>`; null when it passed. */
export function failureCause(result) {
  if (result.passed) return null;
  if (result.error) return `error: ${String(result.error).split('\n')[0]}`;
  const failed = (result.results ?? []).flatMap((scenario) => (scenario.checks ?? [])
    .filter((check) => !check.ok).map((check) => `${scenario.id}: ${check.id ?? check.text}`));
  return failed.length ? failed.slice(0, 3).join('; ') : 'failed without a failed check';
}

const median = (values) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Per flow, from the results.json of many runs: `runs`, `failures`, `causes` (cause → count, most
 * frequent first), `medianMs` and `maxMs` of the measured totals, and `overBudget` (runs over the
 * one-flow budget). Results without a `flow` (a ticket's own script) are left out.
 */
export function flowHistory(results) {
  const byFlow = new Map();
  for (const result of results) {
    if (!result.flow) continue;
    const entry = byFlow.get(result.flow) ?? { flow: result.flow, runs: 0, failures: 0, causes: {}, totals: [] };
    entry.runs += 1;
    const cause = failureCause(result);
    if (cause) { entry.failures += 1; entry.causes[cause] = (entry.causes[cause] ?? 0) + 1; }
    const total = totalMs(result.timings);
    if (total !== undefined) entry.totals.push(total);
    byFlow.set(result.flow, entry);
  }
  return [...byFlow.values()].sort((a, b) => a.flow.localeCompare(b.flow)).map(({ totals, causes, ...entry }) => ({
    ...entry,
    causes: Object.fromEntries(Object.entries(causes).sort((a, b) => b[1] - a[1])),
    medianMs: median(totals),
    maxMs: totals.length ? Math.max(...totals) : undefined,
    overBudget: totals.filter((total) => total > FLOW_BUDGET_SECONDS * 1000).length,
  }));
}

/** The history as a table, one flow per line, with its most frequent failure cause. */
export function historyTable(history) {
  const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '-');
  const rows = history.map((entry) => [entry.flow, String(entry.runs), String(entry.failures), seconds(entry.medianMs), seconds(entry.maxMs),
    String(entry.overBudget), Object.entries(entry.causes)[0]?.join(' ×') ?? '']);
  const table = [['flow', 'runs', 'failures', 'median', 'max', `over ${FLOW_BUDGET_SECONDS}s`, 'top cause'], ...rows];
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
  return table.map((row) => row.map((cell, column) => (column === 0 || column === 6 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
    .join('  ').trimEnd()).join('\n');
}

/** Every results.json under `dir` that a recorded flow wrote, parsed; unreadable files are skipped. */
export function readFlowResults(dir) {
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'results.json') {
        try {
          const result = JSON.parse(readFileSync(full, 'utf8'));
          if (result.flow) found.push(result);
        } catch {
          // A results.json cut short by a cancelled run says nothing about the flow.
        }
      }
    }
  };
  walk(dir);
  return found;
}

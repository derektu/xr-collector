// Judging the status sequences a flow records. A subscription row moves through queued → checking →
// downloading k/n → scheduled and a job through the Jobs page's sections; the UI polls, so a short
// state (checking lasts about 200 ms) may never be sampled, and the checks only require what every
// run shows. Rows are read from the status chip's data attributes, written as `phase`,
// `downloading k/n` or `phase failures`. Each check is { id, ok, text, expected, actual } for the
// recorder's expect.

const PHASES = ['queued', 'checking', 'downloading', 'scheduled'];

/**
 * Every subscription row's status, by row test ID: `phase`, `downloading k/n` or `phase failures`.
 * Runs inside the page, so it is self-contained.
 */
export const subscriptionStatuses = () => Object.fromEntries([...document.querySelectorAll('[data-testid^="source-row-"], [data-testid^="pending-row-"]')]
  .map((row) => {
    const chip = row.querySelector('[data-phase]');
    if (!chip) return [row.dataset.testid, ''];
    const { phase, done, total, failures } = chip.dataset;
    return [row.dataset.testid, phase === 'downloading' ? `downloading ${done}/${total}` : failures !== undefined ? `${phase} ${failures}` : phase];
  }));

/** A sampled status as { phase, done?, total?, failures? }. */
export function subscriptionPhase(value) {
  const [phase, detail] = (value ?? '').split(' ');
  if (phase === 'downloading') {
    const [done, total] = (detail ?? '').split('/').map(Number);
    return { phase, done, total };
  }
  return detail === undefined ? { phase } : { phase, failures: Number(detail) };
}

/** Consecutive pairs `a → b` of `values` where `bad(a, b)` holds, written as text. */
const segments = (values, bad) => values.slice(1).flatMap((value, index) => (bad(values[index], value) ? [`${values[index]} → ${value}`] : []));

/**
 * Checks one subscription's sequence of distinct statuses from its first check to the end: only the
 * four phases of a check, never back to queued once started, phases only forward, downloading k/n
 * with n equal to `total` and k never going back, at least one downloading, and scheduled at the
 * end. `name` prefixes the check IDs and texts (for example `A`).
 */
export function subscriptionSequenceChecks(name, values, { total }) {
  const phases = values.map(subscriptionPhase);
  const rank = (value) => PHASES.indexOf(subscriptionPhase(value).phase);
  const downloading = values.filter((value, index) => phases[index].phase === 'downloading');
  const startedAt = phases.findIndex((phase) => phase.phase !== 'queued');
  const requeued = startedAt < 0 ? [] : segments(values.slice(startedAt), (a, b) => subscriptionPhase(a).phase !== 'queued' && subscriptionPhase(b).phase === 'queued');
  const backwards = segments(values, (a, b) => rank(a) >= 0 && rank(b) >= 0 && rank(b) < rank(a));
  const progressProblems = [
    ...downloading.filter((value) => { const { done, total: n } = subscriptionPhase(value); return n !== total || done >= n; }),
    ...segments(downloading, (a, b) => subscriptionPhase(b).done < subscriptionPhase(a).done),
  ];
  const last = values.at(-1) ?? null;
  return [
    { id: `${name}.status.known`, ok: phases.every((phase) => PHASES.includes(phase.phase)),
      text: `${name} 的狀態只有排隊中、檢查中、下載中 k/n、下次檢查`,
      expected: PHASES, actual: values.filter((value, index) => !PHASES.includes(phases[index].phase)) },
    { id: `${name}.status.no-requeue`, ok: requeued.length === 0,
      text: `${name} 離開排隊中後不再回到排隊中`, expected: '沒有「… → queued」', actual: requeued },
    { id: `${name}.status.forward`, ok: backwards.length === 0,
      text: `${name} 的階段只往前：排隊中 → 檢查中 → 下載中 → 下次`, expected: '沒有倒退的一段', actual: backwards },
    { id: `${name}.status.progress`, ok: progressProblems.length === 0,
      text: `${name} 的下載中 k/${total}：k 只增不減且小於 ${total}`, expected: `每個下載中都是 k/${total}，k 不倒退`, actual: downloading },
    { id: `${name}.status.downloading-seen`, ok: downloading.length > 0,
      text: `${name} 至少出現一次下載中`, expected: '≥ 1 個下載中', actual: downloading.length },
    { id: `${name}.status.final`, ok: last !== null && subscriptionPhase(last).phase === 'scheduled',
      text: `${name} 最後排定下次檢查`, expected: 'scheduled', actual: last },
  ];
}

/**
 * Checks one job's sequence of distinct Jobs page sections (running, queued, failed): once it is in
 * 進行中 it never returns to 排隊中. A job never seen on the page fails, so a title that matches no
 * row cannot pass unjudged.
 */
export function jobSectionChecks(name, sections) {
  const startedAt = sections.indexOf('running');
  const requeued = startedAt < 0 ? [] : segments(sections.slice(startedAt), (a, b) => b === 'queued' && a !== 'queued');
  return [
    { id: `${name}.jobs.no-requeue`, ok: sections.length > 0 && requeued.length === 0,
      text: `工作頁的 ${name} 進了進行中就不再回到排隊中`, expected: '出現在工作頁，沒有「running → queued」',
      actual: sections.length ? requeued : sections },
  ];
}

/** Collapses a sampled log [{ value }] into the sequence of distinct consecutive values. */
export function distinct(samples) {
  return samples.map((sample) => sample.value).filter((value, index, all) => index === 0 || value !== all[index - 1]);
}

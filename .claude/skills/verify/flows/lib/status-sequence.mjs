// Judging the status sequences a flow records. A subscription row moves through 排隊中 → 檢查中 →
// 下載中 k/n → 下次 HH:MM and a job through the Jobs page's sections; the UI polls, so a short state
// (檢查中 lasts about 200 ms) may never be sampled, and the checks only require what every run
// shows. Each check is { id, ok, text, expected, actual } for the recorder's expect.

const PHASES = ['queued', 'checking', 'downloading', 'scheduled'];
const NEXT = /^下次 (\d\d:\d\d|明天 \d\d:\d\d|\d\d-\d\d \d\d:\d\d)$/;

/** A status column text as { phase, done?, total? }; anything the status model does not define is `unknown`. */
export function subscriptionPhase(text) {
  if (text === '排隊中') return { phase: 'queued' };
  if (text === '檢查中') return { phase: 'checking' };
  const downloading = /^下載中 (\d+)\/(\d+)$/.exec(text);
  if (downloading) return { phase: 'downloading', done: Number(downloading[1]), total: Number(downloading[2]) };
  if (NEXT.test(text)) return { phase: 'scheduled' };
  return { phase: 'unknown' };
}

/** Consecutive pairs `a → b` of `values` where `bad(a, b)` holds, written as text. */
const segments = (values, bad) => values.slice(1).flatMap((value, index) => (bad(values[index], value) ? [`${values[index]} → ${value}`] : []));

/**
 * Checks one subscription's sequence of distinct status texts from its first check to the end:
 * known texts only, never back to 排隊中 once started, phases only forward, 下載中 k/n with n equal
 * to `total` and k never going back, at least one 下載中, and 下次 HH:MM at the end. `name` prefixes
 * the check IDs and texts (for example `A`).
 */
export function subscriptionSequenceChecks(name, values, { total }) {
  const phases = values.map(subscriptionPhase);
  const rank = (text) => PHASES.indexOf(subscriptionPhase(text).phase);
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
    { id: `${name}.status.known`, ok: phases.every((phase) => phase.phase !== 'unknown'),
      text: `${name} 的狀態只有排隊中、檢查中、下載中 k/n、下次 HH:MM`,
      expected: '沒有其他狀態文字', actual: values.filter((value, index) => phases[index].phase === 'unknown') },
    { id: `${name}.status.no-requeue`, ok: requeued.length === 0,
      text: `${name} 離開排隊中後不再回到排隊中`, expected: '沒有「… → 排隊中」', actual: requeued },
    { id: `${name}.status.forward`, ok: backwards.length === 0,
      text: `${name} 的階段只往前：排隊中 → 檢查中 → 下載中 → 下次`, expected: '沒有倒退的一段', actual: backwards },
    { id: `${name}.status.progress`, ok: progressProblems.length === 0,
      text: `${name} 的下載中 k/${total}：k 只增不減且小於 ${total}`, expected: `每個下載中都是 k/${total}，k 不倒退`, actual: downloading },
    { id: `${name}.status.downloading-seen`, ok: downloading.length > 0,
      text: `${name} 至少出現一次下載中`, expected: '≥ 1 個下載中', actual: downloading.length },
    { id: `${name}.status.final`, ok: last !== null && subscriptionPhase(last).phase === 'scheduled',
      text: `${name} 最後顯示下次 HH:MM`, expected: '下次 HH:MM', actual: last },
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

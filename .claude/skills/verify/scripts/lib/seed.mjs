// Preconditions through the HTTP API the Web UI calls: the same recognition and actions the add
// dialog sends. Seeding sets up state a scenario starts from; it is never the proof of the feature
// under test, which goes through the screen.
import { waitFor } from './wait.mjs';

async function perform(instance, url, actionId) {
  const { recognition } = await instance.api('/api/url-recognitions', { method: 'POST', body: JSON.stringify({ url }) });
  const action = recognition.actions?.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`${url} offers no "${actionId}" action (status ${recognition.status}, actions ${JSON.stringify(recognition.actions?.map((a) => a.id))})`);
  return instance.api(action.request.path, { method: action.request.method, body: JSON.stringify(action.request.body) });
}

/** Collects one item (a video, an article address) as 新增 → 網址 → 加入 does. */
export const collect = (instance, url) => perform(instance, url, 'collect');

/** Subscribes to a channel or feed with its default settings, as 新增訂閱 → 訂閱 does. */
export const subscribe = (instance, url) => perform(instance, url, 'subscribe');

/** Waits until no job is running or queued. */
export function idle(instance, timeout = 120_000) {
  return waitFor(async () => {
    const { overview } = await instance.api('/api/jobs/overview');
    return overview.running.length === 0 && overview.queued.length === 0 ? overview : null;
  }, 'jobs idle', { timeout, interval: 500 });
}

// Every API response names the server's revision in `XR-Revision`; the page sets `data-revision` on
// its root element to the newest revision every open screen has read, and removes it while a screen
// is still reading. A flow that changes data
// through the API waits until the screen reached the revision of that change, instead of waiting
// for a timer or for text to appear.
import { waitFor } from '../../scripts/lib/wait.mjs';

const cursor = (revision) => {
  const match = /^([0-9a-f]+):(\d+)$/u.exec(revision ?? '');
  return match ? { epoch: match[1], number: Number(match[2]) } : null;
};

/** True when `shown` belongs to the same server instance as `target` and is at least as new. */
export function caughtUp(shown, target) {
  const a = cursor(shown);
  const b = cursor(target);
  return Boolean(a && b && a.epoch === b.epoch && a.number >= b.number);
}

/** The server's revision now, from a read of the UI origin. */
export async function apiRevision(instance) {
  const response = await fetch(`${instance.url}/api/health`);
  const revision = response.headers.get('xr-revision');
  if (!revision) throw new Error('/api/health answered without XR-Revision');
  return revision;
}

/** Resolves once the page shows `revision` (the server's current one when omitted); returns the revision shown. */
export async function screenAt(page, instance, revision, { timeout = 15_000 } = {}) {
  const target = revision ?? await apiRevision(instance);
  return waitFor(async () => {
    const shown = await page.evaluate(() => document.documentElement.dataset.revision ?? null);
    return caughtUp(shown, target) ? shown : null;
  }, `screen at revision ${target}`, { timeout, interval: 50 });
}

/**
 * The Agent port, with the run's own token. Each call returns the JSON body and the revision its
 * response named; an error status throws with the body. The token never goes into evidence.
 */
export async function agentClient(instance) {
  const { connection } = await instance.api('/api/device/agent/connection');
  return async (route, init = {}) => {
    const response = await fetch(`${connection.url}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${connection.token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Agent ${init.method ?? 'GET'} ${route} → ${response.status} ${JSON.stringify(body)}`);
    return { body, revision: response.headers.get('xr-revision') };
  };
}

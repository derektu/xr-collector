/**
 * Resolves once the page has handled every response that reached it before the call. The page sends
 * a request of its own and waits for the answer; the page runs the tasks already queued for the
 * earlier responses, and the renders they schedule, before an answer that needs a round trip to the
 * server. A flow that proves a late response changed nothing checks the screen after this.
 */
export async function pageTurn(page) {
  await page.evaluate(async () => { await (await fetch('/api/health', { cache: 'no-store' })).text(); });
}

/**
 * Records the requests `page` sends with `method` to a path starting with `prefix`. `sent()` resolves,
 * once the page handled everything that reached it before the call (see pageTurn), with the
 * requests so far as `METHOD path`; a flow proving that an action sent nothing asserts it is empty.
 */
export function recordRequests(page, method, prefix) {
  const requests = [];
  const listen = (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === method && pathname.startsWith(prefix)) requests.push(`${method} ${pathname}`);
  };
  page.on('request', listen);
  return {
    async sent() {
      await pageTurn(page);
      return [...requests];
    },
    stop: () => page.off('request', listen),
  };
}

/**
 * The Agent port, with the run's own token. Each call returns the JSON body; an error status throws
 * with the body. The token never goes into evidence.
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
    return body;
  };
}

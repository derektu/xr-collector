import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CHANGE_KINDS, parseCursor, type ChangeBatch, type ChangeFeed, type ChangeKind,
} from '../core/change-feed.js';
import { CollectorError } from '../core/types.js';

/** Event connections one listener serves at once. */
export const MAX_STREAMS = 16;
/** A comment line keeps an idle connection open through sleep and proxies. */
const HEARTBEAT_MS = 30_000;
const MAX_WAIT_SECONDS = 60;

/**
 * Serves the change stream: the `XR-Revision` header on every API response, the event stream at
 * `/api/events` and the waiting read at `/api/changes`. A read's header names the revision its
 * data is at least as new as; a write's header includes the changes the write itself made.
 */
export function registerChangeRoutes(app: FastifyInstance, changes: ChangeFeed, routeConfig: () => object): void {
  const started = new WeakMap<object, string>();
  app.addHook('onRequest', async (request) => { started.set(request, changes.revision); });
  // A request that an earlier hook refused (wrong host, missing token) never reached the hook above
  // and learns nothing about the changes.
  app.addHook('onSend', async (request, reply, payload) => {
    const revision = started.get(request);
    if (revision !== undefined && request.url.startsWith('/api/')) {
      const read = request.method === 'GET' || request.method === 'HEAD';
      reply.header('XR-Revision', read ? revision : changes.flush());
    }
    return payload;
  });

  const streams = new Set<() => void>();
  const waiting = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of [...streams]) end();
    for (const wake of [...waiting]) wake();
  });

  app.get<{ Querystring: { after?: string } }>('/api/events', routeConfig(), async (request, reply) => {
    if (streams.size >= MAX_STREAMS) throw new CollectorError('too_many_streams', '同時開啟的事件連線過多，請關閉其他連線後再試。');
    const lastEventId = request.headers['last-event-id'];
    const after = parseCursor(typeof lastEventId === 'string' ? lastEventId : request.query.after);
    stream(reply, after);
  });

  function stream(reply: FastifyReply, after: ReturnType<typeof parseCursor>): void {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'XR-Revision': changes.revision,
    });
    const send = (event: string, data: unknown, id?: string) => {
      response.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    response.write('retry: 1000\n\n');
    const catchup = after ? changes.since(after) : null;
    if (catchup?.kind === 'reset') send('reset', { revision: changes.revision }, changes.revision);
    else send('hello', { revision: changes.revision }, after ? undefined : changes.revision);
    for (const batch of catchup?.kind === 'batches' ? catchup.batches : []) send('change', batch, batch.revision);
    const unsubscribe = changes.subscribe((batch) => send('change', batch, batch.revision));
    const heartbeat = setInterval(() => response.write(': \n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    const end = () => {
      if (!streams.delete(end)) return;
      unsubscribe();
      clearInterval(heartbeat);
      response.end();
    };
    streams.add(end);
    response.once('close', end);
  }

  app.get<{ Querystring: Record<string, unknown> }>('/api/changes', routeConfig(), async (request, reply) => {
    const query = request.query;
    const wait = query.wait === undefined ? 0 : Number(query.wait);
    if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) {
      throw new CollectorError('invalid_request', `wait 必須是 0 到 ${MAX_WAIT_SECONDS} 的整數秒數。`);
    }
    const kinds = list(query.kind);
    if (kinds?.some((kind) => !CHANGE_KINDS.includes(kind as ChangeKind))) {
      throw new CollectorError('invalid_request', `kind 只能是 ${CHANGE_KINDS.join('、')}。`);
    }
    const ids = list(query.id);
    const matches = (batch: ChangeBatch): ChangeBatch | null => {
      const selected = batch.changes.filter((change) => (!kinds || kinds.includes(change.kind))
        && (!ids || ('id' in change && ids.includes(change.id))));
      return selected.length > 0 ? { ...batch, changes: selected } : null;
    };
    if (query.after === undefined) return { revision: changes.revision, reset: false, batches: [] };
    const after = parseCursor(query.after);
    if (!after) throw new CollectorError('invalid_request', 'after 必須是先前回應的 revision，格式為 <epoch>:<number>。');
    const read = () => {
      const catchup = changes.since(after);
      if (catchup.kind === 'reset') return { revision: changes.revision, reset: true, batches: [] };
      return { revision: changes.revision, reset: false, batches: catchup.batches.map(matches).filter((batch): batch is ChangeBatch => batch !== null) };
    };
    const now = read();
    if (now.reset || now.batches.length > 0 || wait === 0) return now;
    return new Promise((resolve) => {
      const finish = () => {
        if (!waiting.has(finish)) return;
        clearTimeout(timer);
        unsubscribe();
        waiting.delete(finish);
        resolve(read());
      };
      const timer = setTimeout(finish, wait * 1000);
      const unsubscribe = changes.subscribe((batch) => { if (matches(batch)) finish(); });
      waiting.add(finish);
      // The client gave up waiting.
      reply.raw.once('close', finish);
    });
  });
}

function list(value: unknown): string[] | null {
  if (value === undefined) return null;
  const items = (Array.isArray(value) ? value : [value]).flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

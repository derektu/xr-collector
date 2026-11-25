import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../../shared/api/api-routes.js';
import { serve } from '../api-route.js';
import type { ChangeFeed } from '../../../app/runtime/index.js';
import { CHANGE_KINDS, parseCursor, type ChangeBatch, type ChangeKind } from '../../../shared/api/changes.js';
import { CollectorError } from '../../../shared/lib/collector-error.js';
import { maskSecretsJson } from '../../../shared/lib/redact.js';

export const MAX_STREAMS = 16;
// External: A comment line keeps an idle server-sent events connection open through sleep and proxies.
// https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes
const HEARTBEAT_MS = 30_000;
const MAX_WAIT_SECONDS = 60;

export function registerChangeRoutes(app: FastifyInstance, changes: ChangeFeed): void {
  const started = new WeakMap<object, string>();
  app.addHook('onRequest', async (request) => { started.set(request, changes.revision); });
  // External: Fastify still runs onSend for a request an earlier hook replied to, without the onRequest hook above.
  // https://fastify.dev/docs/latest/Reference/Hooks/#respond-to-a-request-from-a-hook
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

  serve(app, API_ROUTES.events, async (_request, reply) => {
    if (streams.size >= MAX_STREAMS) throw new CollectorError('too_many_streams', '同時開啟的事件連線過多，請關閉其他連線後再試。');
    stream(reply);
  });

  function stream(reply: FastifyReply): void {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'XR-Revision': changes.revision,
    });
    const send = (event: string, data: unknown) => {
      response.write(`event: ${event}\ndata: ${maskSecretsJson(data)}\n\n`);
    };
    response.write('retry: 1000\n\n');
    send('hello', { revision: changes.revision });
    const unsubscribe = changes.subscribe((batch) => send('change', batch));
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

  serve(app, API_ROUTES.changes, async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>, reply) => {
    const query = request.query;
    const wait = query.wait === undefined ? 0 : Number(query.wait);
    if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) {
      throw new CollectorError('invalid_request', `wait 必須是 0 到 ${MAX_WAIT_SECONDS} 的整數秒數。`);
    }
    const kinds = list(query.kind);
    if (kinds?.some((kind) => !isChangeKind(kind))) {
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
      reply.raw.once('close', finish);
    });
  });
}

function list(value: unknown): string[] | null {
  if (value === undefined) return null;
  const items = (Array.isArray(value) ? value : [value]).flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

function isChangeKind(value: string): value is ChangeKind {
  return CHANGE_KINDS.some((kind) => kind === value);
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../../shared/api/api-routes.js';
import { CollectorError } from '../../../shared/lib/collector-error.js';
import { isLogLevel } from '../../../shared/log/log-fields.js';
import type { LogLevel, LogQuery, LogReader, LogWriter } from '../../../shared/log/log-types.js';
import { serve } from '../api-route.js';
import { isInstant, pagination, singleValues } from './query-params.js';

const LOG_PARAMETERS = new Set(['level', 'since', 'until', 'limit', 'cursor']);
const PAGE_LOG_FIELDS = new Set(['level', 'message', 'stack']);

export function registerLogRoutes(app: FastifyInstance, log: LogReader): void {
  serve(app, API_ROUTES.logs, async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>) => log.read(logQuery(singleValues(request.query))));
}

export function registerPageLogRoute(app: FastifyInstance, log: LogWriter): void {
  serve(app, API_ROUTES.writePageLog, async (request: FastifyRequest<{ Body: unknown }>) => {
    const body: unknown = request.body;
    if (typeof body !== 'object' || body === null || Object.keys(body).some((key) => !PAGE_LOG_FIELDS.has(key))) {
      throw new CollectorError('invalid_request', '請只提供 level、message 與 stack。');
    }
    const level: unknown = Reflect.get(body, 'level');
    const message: unknown = Reflect.get(body, 'message');
    const stack: unknown = Reflect.get(body, 'stack');
    if (level !== 'warn' && level !== 'error') throw new CollectorError('invalid_request', 'level 只能是 warn 或 error。');
    if (typeof message !== 'string' || message === '') throw new CollectorError('invalid_request', 'message 必須是非空字串。');
    if (stack !== undefined && typeof stack !== 'string') throw new CollectorError('invalid_request', 'stack 必須是字串。');
    log.write({ level, source: 'page', message, ...(stack === undefined ? {} : { stack }) });
    return {};
  });
}

function levels(value: string | undefined): LogLevel[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(',').map((item) => item.trim());
  if (!items.every(isLogLevel)) throw new CollectorError('invalid_request', 'level 只能是 debug、info、warn、error，以逗號分隔。');
  return items;
}

function logQuery(query: Record<string, string | undefined>): LogQuery {
  const unknown = Object.keys(query).find((key) => !LOG_PARAMETERS.has(key));
  if (unknown) throw new CollectorError('invalid_request', `不支援的查詢參數：${unknown}`);
  const level = levels(query.level);
  for (const key of ['since', 'until'] as const) {
    const value = query[key];
    if (value !== undefined && !isInstant(value)) throw new CollectorError('invalid_request', `${key} 必須是帶時區的 ISO 時間。`);
  }
  if (query.cursor !== undefined && (query.cursor === '' || query.cursor.length > 500)) {
    throw new CollectorError('invalid_request', '分頁位置無效。');
  }
  const { limit } = pagination({ limit: query.limit ?? '50' });
  return {
    ...(level ? { level } : {}),
    ...(query.since ? { since: query.since } : {}),
    ...(query.until ? { until: query.until } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit,
  };
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import { CollectorError } from '../../core/collector-error.js';
import type {
  ActivityGroupPage,
  ActivityLogHealth,
  ActivityPage,
  ActivityQuery,
  ActivitySummaryPage,
  EventSeverity,
} from '../../core/activity-types.js';
import { serve } from '../api-route.js';
import { isInstant, pagination, singleValues } from './query-params.js';

/** The device activity log, scoped to the active Vault; readable whatever state the Vault is in. */
export interface ActivityAccess {
  query(query: ActivityQuery): Promise<ActivityPage>;
  summary?(query: ActivityQuery): Promise<ActivitySummaryPage>;
  group?(groupId: string, limit?: number, cursor?: string, severity?: EventSeverity[]): Promise<ActivityGroupPage>;
  health(): ActivityLogHealth;
}

/** The activity log: raw events or check summaries, and the events of one group. */
export function registerActivityRoutes(app: FastifyInstance, activity: ActivityAccess): void {
  serve(app, API_ROUTES.activity, async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>) => {
    const query = activityQuery(singleValues(request.query));
    return query.view === 'summary' && !query.jobId && activity.summary
      ? activity.summary(query) : activity.query({ ...query, view: 'raw' });
  });
  serve(app, API_ROUTES.activityGroup, async (request: FastifyRequest<{ Params: { groupId: string }; Querystring: Record<string, unknown> }>) => {
    const query = singleValues(request.query);
    const unknown = Object.keys(query).find((key) => key !== 'limit' && key !== 'cursor' && key !== 'severity');
    if (unknown) throw new CollectorError('invalid_request', `不支援的查詢參數：${unknown}`);
    const { limit } = pagination({ limit: query.limit ?? '50' });
    const severity = query.severity?.split(',').map((item) => item.trim()).filter(Boolean);
    if (severity && (severity.length === 0 || !severity.every((value) => SEVERITIES.has(value)))) {
      throw new CollectorError('invalid_request', 'severity 只能是 debug、info、warning、error，以逗號分隔。');
    }
    if (!activity.group) throw new CollectorError('activity_group_expired', '此查詢連結已失效，請返回並重新整理。');
    return activity.group(request.params.groupId, limit, query.cursor, severity as EventSeverity[] | undefined);
  });
}

const SEVERITIES: ReadonlySet<string> = new Set<EventSeverity>(['debug', 'info', 'warning', 'error']);
const ACTIVITY_PARAMETERS = new Set(['view', 'severity', 'eventType', 'jobId', 'subscriptionId', 'sourceType', 'since', 'until', 'limit', 'cursor']);

function activityQuery(query: Record<string, string | undefined>): ActivityQuery {
  const unknown = Object.keys(query).find((key) => !ACTIVITY_PARAMETERS.has(key));
  if (unknown) throw new CollectorError('invalid_request', `不支援的查詢參數：${unknown}`);
  if (query.view !== undefined && query.view !== 'raw' && query.view !== 'summary') {
    throw new CollectorError('invalid_request', 'view 只能是 raw 或 summary。');
  }
  const list = (value: string | undefined) => value?.split(',').map((item) => item.trim()).filter(Boolean);
  const severity = list(query.severity);
  if (severity && (severity.length === 0 || !severity.every((value) => SEVERITIES.has(value)))) {
    throw new CollectorError('invalid_request', 'severity 只能是 debug、info、warning、error，以逗號分隔。');
  }
  const eventType = list(query.eventType);
  if (eventType && (eventType.length === 0 || !eventType.every((value) => /^[a-z_.]{1,60}$/u.test(value)))) {
    throw new CollectorError('invalid_request', 'eventType 格式無效。');
  }
  for (const key of ['jobId', 'subscriptionId', 'sourceType'] as const) {
    const value = query[key];
    if (value !== undefined && (value === '' || value.length > 200)) throw new CollectorError('invalid_request', `${key} 長度須在 1 到 200 之間。`);
  }
  for (const key of ['since', 'until'] as const) {
    const value = query[key];
    if (value !== undefined && !isInstant(value)) throw new CollectorError('invalid_request', `${key} 必須是 ISO 時間。`);
  }
  if (query.cursor !== undefined && (query.cursor === '' || query.cursor.length > 500)) {
    throw new CollectorError('invalid_request', '分頁位置無效。');
  }
  const { limit } = pagination({ limit: query.limit ?? '50' });
  return {
    ...(query.view ? { view: query.view as 'raw' | 'summary' } : {}),
    ...(severity ? { severity: severity as EventSeverity[] } : {}),
    ...(eventType ? { eventType } : {}),
    ...(query.jobId ? { jobId: query.jobId } : {}),
    ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    ...(query.since ? { since: query.since } : {}),
    ...(query.until ? { until: query.until } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit,
  };
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import { CollectorError } from '../../core/collector-error.js';
import type { JobSubmission } from '../../core/job-types.js';
import type { CollectionSchedule, CollectionScheduleView } from '../../core/subscription-types.js';
import { serve } from '../api-route.js';
import type { NetworkGuard } from './network.js';

export interface ScheduleManagement {
  getSchedule(): Promise<CollectionSchedule>;
  updateSchedule(input: { enabled: boolean }): Promise<CollectionSchedule>;
  /** Checks every enabled subscription now. */
  runNow(): Promise<JobSubmission[]>;
}

const SCHEDULE_FIELDS = new Set(['enabled']);

/** The automatic check switch; one switch covers the subscriptions of every source type. */
export function registerScheduleRoutes(app: FastifyInstance, schedule: ScheduleManagement, network: NetworkGuard): void {
  const scheduleView = (value: CollectionSchedule): CollectionScheduleView => ({ ...value, connectivity: network.status() });
  serve(app, API_ROUTES.schedule, async () => ({
    schedule: scheduleView(await schedule.getSchedule()),
  }));

  serve(app, API_ROUTES.setSchedule, async (request: FastifyRequest<{ Body: Record<string, unknown> | null }>) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new CollectorError('invalid_request', '自動檢查設定必須是 JSON 物件。');
    }
    const keys = Object.keys(body);
    const unknown = keys.find((key) => !SCHEDULE_FIELDS.has(key));
    if (unknown) throw new CollectorError('invalid_request', `不支援的設定欄位：${unknown}`);
    if (typeof body.enabled !== 'boolean') throw new CollectorError('invalid_request', '自動檢查開關必須是 true 或 false。');
    return { schedule: scheduleView(await schedule.updateSchedule({ enabled: body.enabled })) };
  });
}

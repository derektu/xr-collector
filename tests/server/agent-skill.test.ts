import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ChangeFeed } from '../../src/core/change-feed.js';
import { describe, expect, it } from 'vitest';
import { createHttpApp, type HttpAppOptions } from '../../src/server/app.js';

const skillPath = path.resolve('skills/xr-collector-agent/SKILL.md');

/** Every `METHOD /api/...` pair the Skill's HTTP contract table lists, e.g. "`GET`／`PUT /api/x`". */
function contractRoutes(skill: string): Array<{ method: string; url: string }> {
  const table = skill.slice(skill.indexOf('## HTTP 契約'));
  const routes: Array<{ method: string; url: string }> = [];
  for (const row of table.split('\n').filter((line) => line.startsWith('| `'))) {
    const firstCell = row.split('|')[1] ?? '';
    let methods: string[] = [];
    for (const [, segment] of firstCell.matchAll(/`([^`]+)`/gu)) {
      const match = /^(GET|POST|PUT|PATCH|DELETE)(?: (\/api\/\S+))?$/u.exec(segment!);
      if (!match) continue;
      methods.push(match[1]!);
      if (match[2]) {
        for (const method of methods) routes.push({ method, url: match[2] });
        methods = [];
      }
    }
  }
  return routes;
}

describe('Agent Skill', () => {
  it('updates stale connection data after a refused or unauthorized health check without scanning ports', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const connection = skill.slice(skill.indexOf('## 連線'), skill.indexOf('## 操作範例'));
    const healthStep = connection.split('\n').find((line) => line.startsWith('4. ')) ?? '';

    expect(healthStep).toContain('無法連線或逾時');
    expect(healthStep).toContain('XR Collector 已開啟');
    expect(healthStep).toContain('若 App 已開啟');
    expect(healthStep).toContain('重新下載 Skill');
    expect(healthStep).toContain('複製目前連線資料');
    expect(healthStep).toContain('`connection.json`');
    expect(healthStep).toContain('401 表示金鑰已失效');
    expect(healthStep).toContain('不要掃描其他 port');
    expect(connection).toContain('不自行啟動 XR Collector');
  });

  it('lists only routes the server registers, including the document and search contract', async () => {
    const stub = {} as never;
    const options: HttpAppOptions = {
      collector: stub, jobs: stub, activity: stub, transfer: stub, subscriptions: [{ type: 'youtube' } as never], schedule: stub, search: stub, vaultSetup: stub,
      pacing: [{ group: 'youtube' } as never], agentToken: 'skill-test', changes: new ChangeFeed(),
      agentConnection: {
        status: () => ({ state: 'available', activeUrl: 'http://127.0.0.1:1', activePort: 1, configured: { mode: 'auto' }, restartRequired: false, message: 'test' }),
        connection: () => ({ url: 'http://127.0.0.1:1', token: 'test' }), authorize: () => true,
        configure: async () => ({ state: 'available', activeUrl: 'http://127.0.0.1:1', activePort: 1, configured: { mode: 'auto' }, restartRequired: false, message: 'test' }),
        resetKey: async () => ({ url: 'http://127.0.0.1:1', token: 'test' }), download: async () => Buffer.from('zip'),
      },
    };
    const app = await createHttpApp(options);
    await app.ready();
    const routes = contractRoutes(await readFile(skillPath, 'utf8'));

    expect(routes.length).toBeGreaterThan(25);
    expect(routes).toEqual(expect.arrayContaining([
      { method: 'GET', url: '/api/documents' },
      { method: 'GET', url: '/api/documents/sources' },
      { method: 'GET', url: '/api/documents/:id' },
      { method: 'DELETE', url: '/api/documents/:id' },
      { method: 'GET', url: '/api/search' },
      { method: 'GET', url: '/api/search/status' },
      { method: 'POST', url: '/api/subscription-previews' },
      { method: 'PUT', url: '/api/schedule' },
      { method: 'GET', url: '/api/source-types' },
      { method: 'POST', url: '/api/url-recognitions' },
      { method: 'GET', url: '/api/subscriptions' },
      { method: 'GET', url: '/api/subscriptions/:type/:id' },
      { method: 'GET', url: '/api/activity' },
      { method: 'GET', url: '/api/activity/groups/:groupId' },
      { method: 'GET', url: '/api/jobs/summary' },
      { method: 'POST', url: '/api/jobs/:id/retry' },
      { method: 'GET', url: '/api/pacing' },
      { method: 'POST', url: '/api/submissions' },
      { method: 'POST', url: '/api/items' },
      { method: 'POST', url: '/api/subscriptions' },
      { method: 'PATCH', url: '/api/subscriptions/:type/:id' },
      { method: 'DELETE', url: '/api/subscriptions/:type/:id' },
      { method: 'POST', url: '/api/subscriptions/:type/:id/apply-settings' },
      { method: 'POST', url: '/api/subscription-checks' },
      { method: 'GET', url: '/api/schedule' },
    ]));
    for (const route of routes) {
      expect(app.hasRoute(route), `${route.method} ${route.url}`).toBe(true);
    }
    await app.close();
  });

  it('documents the stable source filters that browse and search accept', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const parameter of ['sourceType', 'publisherId', 'offset', 'limit']) {
      expect(skill).toContain(`\`${parameter}\``);
    }
    expect(skill).toContain('`channel` 參數回 400');
    expect(skill).not.toContain('estimatedTotalHits');
    expect(skill).not.toContain('channelTitle');
  });

  it('documents the subscription contract the server enforces', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const { INTERVAL_OPTIONS, BACKFILL_DAYS, BACKFILL_MAX_ITEMS } = await import('../../src/core/collection-settings.js');
    expect(skill).toContain(`只接受 ${INTERVAL_OPTIONS.join('、')}`);
    expect(skill).toContain(`\`backfillDays\`（${BACKFILL_DAYS.min}–${BACKFILL_DAYS.max} 的整數）`);
    expect(skill).toContain(`\`backfillMaxItems\`（${BACKFILL_MAX_ITEMS.min}–${BACKFILL_MAX_ITEMS.max} 的整數）`);
    expect(skill).toContain('YouTube 30 分、30 天、10 支');
    expect(skill).toContain('60 分、7 天、30 篇');
    for (const retired of ['backfillWindow', '日曆月']) expect(skill).not.toContain(retired);
    for (const term of ['backfillDays', 'backfillMaxItems', 'subscription_paused', 'documentsKept', 'skipReason', 'out_of_range', 'subscription_not_found', '每次檢查']) {
      expect(skill).toContain(term);
    }
    expect(skill).not.toContain('1–10080');
    // Every check follows one rule; there is no incremental mode or follow-up batch.
    for (const retired of ['增量', '`backlog`', '游標']) expect(skill).not.toContain(retired);
  });

  it('documents the source list and URL recognition contract', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const term of ['`ready`', '`login_required`', '`unsupported`', '`unavailable`', '`collect`', '`subscribe`', '`resume`', 'unsubscribed', '`collection`', '`failures`', '/api/jobs/overview', '/api/jobs/:id/dismiss', 'lastError', '`error`']) {
      expect(skill).toContain(term);
    }
  });

  it('documents the subscription status, pending requests, removed channels and removal with documents (N75-T10)', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const term of ['`checkStatus`', '"checking"', '"downloading"', '"retrying"', '"adding"', '"queued"', '"scheduled"', '"paused"', '"auto_check_off"', '"login_required"',
      '`pending`', '`removed: true`', '`documents=keep|delete`', '`documentsDeleted`']) {
      expect(skill).toContain(term);
    }
  });

  it('documents resumption after a restart and automatic retries', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const term of ['`recovery`', '`resumedCount`', '`uncleanStops`', '`interrupted_repeatedly`', '`retry`', '`nextAttemptAt`', '`maxAttempts`', '`superseded`']) {
      expect(skill).toContain(term);
    }
    expect(skill).not.toContain('`completed`、`failed` 或 `interrupted`');
  });

  it('documents the activity log, its retention and manual retry', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const term of ['`severity`', '`eventType`', '`subscriptionId`', '`nextCursor`', '`retentionDays`', '`activityLog`', '`failing`', '`dropped`',
      '`job_not_retryable`', '`retryOf`', '`retriedBy`', '`activityIncomplete: true`', '保留最近 30 天', '`[已遮蔽]`', '`outcome: skipped`',
      '`view=summary`', '`sourceType`', '`groupId`', '`activity_group_expired`', '`activity_snapshot_expired`']) {
      expect(skill).toContain(term);
    }
  });

  it('documents deletion, its records and explicit collection again', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const term of ['`DELETE /api/documents/:id`', '`document_deleted`', '`skipReason` 為 `deleted`', '`deletedAt`', '`indexed: false`',
      '`document.deleted`', '`document.recollected`', '以單支網址明確收集']) {
      expect(skill).toContain(term);
    }
  });
});

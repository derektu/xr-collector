import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  it('lists only routes the server registers, including the document and search contract', async () => {
    const stub = {} as never;
    const options: HttpAppOptions = {
      collector: stub, jobs: stub, activity: stub, transfer: stub, channels: stub, schedule: stub, search: stub, vaultSetup: stub,
      agentToken: 'skill-test',
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
      { method: 'POST', url: '/api/youtube/channel-previews' },
      { method: 'PUT', url: '/api/youtube/schedule' },
      { method: 'GET', url: '/api/source-types' },
      { method: 'POST', url: '/api/url-recognitions' },
      { method: 'GET', url: '/api/sources' },
      { method: 'GET', url: '/api/sources/:type/:id' },
      { method: 'GET', url: '/api/activity' },
      { method: 'GET', url: '/api/jobs/summary' },
      { method: 'POST', url: '/api/jobs/:id/retry' },
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
    const { INTERVAL_OPTIONS, BACKFILL_WINDOWS, BACKFILL_LIMITS } = await import('../../src/channels/collection-policy.js');
    expect(skill).toContain(`只接受 ${INTERVAL_OPTIONS.join('、')}`);
    expect(skill).toContain(BACKFILL_WINDOWS.map((window) => `\`${window}\``).join('、'));
    expect(skill).toContain(`（${BACKFILL_LIMITS.join('、')}）`);
    for (const term of ['backfillWindow', 'backfillMaxItems', 'channel_paused', 'documentsKept', 'skipReason', 'out_of_range', 'subscription_paused', '每次檢查']) {
      expect(skill).toContain(term);
    }
    expect(skill).not.toContain('1–10080');
    // Every check follows one rule; there is no incremental mode or follow-up batch.
    for (const retired of ['增量', '`backlog`', '游標']) expect(skill).not.toContain(retired);
  });

  it('documents the source list and URL recognition contract', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const term of ['`ready`', '`login_required`', '`unsupported`', '`unavailable`', '`collect`', '`subscribe`', '`resume`', 'unsubscribed', 'recentJobs', 'lastError', '`error`']) {
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
      '`job_not_retryable`', '`retryOf`', '`retriedBy`', '`activityIncomplete: true`', '保留最近 30 天', '`[已遮蔽]`', '`outcome: skipped`']) {
      expect(skill).toContain(term);
    }
  });

  it('documents deletion, its records and explicit collection again', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const term of ['`DELETE /api/documents/:id`', '`document_deleted`', '`skipReason` 為 `deleted`', '`kind: deletion`', '`indexed: false`',
      '`document.deleted`', '`document.recollected`', '以單支網址明確收集']) {
      expect(skill).toContain(term);
    }
  });
});

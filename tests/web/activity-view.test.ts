// The activity page reads raw events and summaries from one route and tells them apart by the
// response's `view`. A page of the other shape, or one that names no view, is an error the page
// reports, never rows read as empty.
import { describe, expect, it } from 'vitest';
import type { ActivityLogHealth, ActivityPage, ActivitySummaryPage } from '../../src/core/activity-types.js';
import { pageOfView } from '../../src/web/activity-view.js';

const HEALTH: ActivityLogHealth = { state: 'ok', pending: 0, dropped: 0, lastFailureAt: null, lastError: null, skippedLines: 0 };
const RAW: ActivityPage = { view: 'raw', events: [], nextCursor: null, retentionDays: 30, log: HEALTH };
const SUMMARY: ActivitySummaryPage = { view: 'summary', entries: [], nextCursor: null, retentionDays: 30, log: HEALTH };

/** A page as a server that does not name its view would send it. */
function unnamed(page: ActivityPage | ActivitySummaryPage): ActivityPage | ActivitySummaryPage {
  const { view: _view, ...rest } = page;
  return rest as ActivityPage | ActivitySummaryPage;
}

describe('activity page view', () => {
  it('answers the page whose view matches the read', () => {
    expect(pageOfView(RAW, 'raw')).toBe(RAW);
    expect(pageOfView(SUMMARY, 'summary')).toBe(SUMMARY);
  });

  it('rejects a page whose view does not match the read', () => {
    expect(() => pageOfView(SUMMARY, 'raw')).toThrow('answered view "summary" to a raw query');
    expect(() => pageOfView(RAW, 'summary')).toThrow('answered view "raw" to a summary query');
  });

  it('rejects a page that names no view', () => {
    expect(() => pageOfView(unnamed(RAW), 'raw')).toThrow('answered view undefined to a raw query');
    expect(() => pageOfView(unnamed(SUMMARY), 'summary')).toThrow('answered view undefined to a summary query');
  });
});

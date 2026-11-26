// Broken, the activity page shows a malformed page as empty rows instead of an error.
import { describe, expect, it } from 'vitest';
import type { ActivityLogHealth, ActivityPage, ActivitySummaryPage } from '../../../../src/shared/activity/activity-types.js';
import { pageOfView } from '../../../../src/transport/web/api/activity-view.js';

const HEALTH: ActivityLogHealth = { dropped: 0, lastFailureAt: null, lastError: null, skippedLines: 0 };
const RAW: ActivityPage = { view: 'raw', events: [], nextCursor: null, retentionDays: 30, log: HEALTH };
const SUMMARY: ActivitySummaryPage = { view: 'summary', entries: [], nextCursor: null, retentionDays: 30, log: HEALTH };

function withoutView(page: ActivityPage | ActivitySummaryPage): ActivityPage | ActivitySummaryPage {
  const { view: _view, ...rest } = page;
  return rest as ActivityPage | ActivitySummaryPage;
}

describe('activity page view', () => {
  it('answers the page whose view matches the read', () => {
    expect(pageOfView(RAW, 'raw')).toBe(RAW);
    expect(pageOfView(SUMMARY, 'summary')).toBe(SUMMARY);
  });

  it('rejects a page whose view does not match the read, so a wrong answer never shows as an empty log', () => {
    expect(() => pageOfView(SUMMARY, 'raw')).toThrow('answered view "summary" to a raw query');
    expect(() => pageOfView(RAW, 'summary')).toThrow('answered view "raw" to a summary query');
  });

  it('rejects a page that names no view', () => {
    expect(() => pageOfView(withoutView(RAW), 'raw')).toThrow('answered view undefined to a raw query');
    expect(() => pageOfView(withoutView(SUMMARY), 'summary')).toThrow('answered view undefined to a summary query');
  });
});

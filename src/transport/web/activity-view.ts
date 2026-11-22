import type { ActivityPage, ActivitySummaryPage } from '../../shared/activity/activity-types.js';

type ActivityAnswer = ActivityPage | ActivitySummaryPage;

export function pageOfView<View extends ActivityAnswer['view']>(page: ActivityAnswer, view: View): Extract<ActivityAnswer, { view: View }> {
  if (page.view !== view) throw new Error(`The activity log answered view ${JSON.stringify(page.view)} to a ${view} query.`);
  return page as Extract<ActivityAnswer, { view: View }>;
}

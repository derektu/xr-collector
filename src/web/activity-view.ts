import type { ActivityPage, ActivitySummaryPage } from '../core/activity-types.js';

type ActivityAnswer = ActivityPage | ActivitySummaryPage;

/**
 * The activity route answers raw events or a summary, and names which in `view`. A page whose
 * `view` is not the one the read asked for is an error, so the log never shows it as empty.
 */
export function pageOfView<View extends ActivityAnswer['view']>(page: ActivityAnswer, view: View): Extract<ActivityAnswer, { view: View }> {
  if (page.view !== view) throw new Error(`The activity log answered view ${JSON.stringify(page.view)} to a ${view} query.`);
  return page as Extract<ActivityAnswer, { view: View }>;
}

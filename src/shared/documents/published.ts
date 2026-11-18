/**
 * Publish times as sources report them: an ISO time, or a date without a time, which means 00:00 UTC
 * of that date. Listings may report approximate times, and some report none.
 */

/** A publish time as an instant; null when there is none or it cannot be read. */
export function publishedInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** True when the publish time is on or after `start`; an unknown time counts as inside the range. */
export function publishedSince(value: string | null | undefined, start: Date | string): boolean {
  const instant = publishedInstant(value);
  return instant === null || instant >= new Date(start).getTime();
}

/** A coming local time: today (or already past), tomorrow, or a later day with its month and day. */
export type UpcomingTime = { day: 'today' | 'tomorrow'; time: string } | { day: 'later'; date: string; time: string };

/** When `value` comes, by local day from `now`; a time already past counts as today. */
export function upcomingTime(value: string, now: Date): UpcomingTime {
  const date = new Date(value);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOf = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
  if (date.getTime() < startOf(1)) return { day: 'today', time };
  if (date.getTime() < startOf(2)) return { day: 'tomorrow', time };
  return { day: 'later', date: `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time };
}

/** "18:52" today, "明天 08:00" tomorrow, "10-24 08:00" on a later day. */
export function upcomingTimeText(at: UpcomingTime): string {
  switch (at.day) {
    case 'today': return at.time;
    case 'tomorrow': return `明天 ${at.time}`;
    case 'later': return `${at.date} ${at.time}`;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

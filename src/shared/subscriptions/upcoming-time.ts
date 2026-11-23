export type UpcomingTime = { day: 'today' | 'tomorrow'; time: string } | { day: 'later'; date: string; time: string };

export function upcomingTime(value: string, now: Date): UpcomingTime {
  const date = new Date(value);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOf = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
  if (date.getTime() < startOf(1)) return { day: 'today', time };
  if (date.getTime() < startOf(2)) return { day: 'tomorrow', time };
  return { day: 'later', date: `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time };
}

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

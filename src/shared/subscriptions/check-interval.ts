/** A check interval in words, e.g. "每 30 分鐘", "每 3 小時" or "每天". Every subscription has one, whatever its type. */
export function intervalLabel(minutes: number): string {
  if (minutes === 1440) return '每天';
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小時`;
  return `每 ${minutes} 分鐘`;
}

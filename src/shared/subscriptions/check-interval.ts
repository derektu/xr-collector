export function intervalLabel(minutes: number): string {
  if (minutes === 1440) return '每天';
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小時`;
  return `每 ${minutes} 分鐘`;
}

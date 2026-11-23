export function collectedBeforeDeletion(collectedAt: string | undefined, deletedAt: string): boolean {
  return !collectedAtReadable(collectedAt) || Date.parse(collectedAt) <= Date.parse(deletedAt);
}

export function collectedAtReadable(collectedAt: unknown): collectedAt is string {
  return typeof collectedAt === 'string' && !Number.isNaN(Date.parse(collectedAt));
}

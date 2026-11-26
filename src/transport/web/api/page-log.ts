import { api } from './api-client.js';

export function logPageProblem(level: 'warn' | 'error', message: string, error?: unknown): void {
  const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
  const stack = error instanceof Error ? error.stack : undefined;
  void api.writePageLog({ level, message: `${message}${detail}`, ...(stack === undefined ? {} : { stack }) }).catch(() => undefined);
}

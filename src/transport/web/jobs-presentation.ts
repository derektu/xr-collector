import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { JobError, JobOverviewEntry } from '../../shared/jobs/job-types.js';
import { displayUrl, failureLabel, retryCause, retryCauseText } from './source-presentation.js';
import type { RetryCauseView } from './source-presentation.js';
import { clockTime, retryAtText, targetNoun } from './subscription-presentation.js';

export interface JobEntryLabel {
  icon: string;
  title: string;
  named: boolean;
  subtitle: string | null;
  status: { text: string; tone: 'collecting' | 'retrying' } | null;
  progress: { done: number; total: number } | null;
  retryReason: string | null;
  reason: string | null;
}

export type JobEntryStatus =
  | { state: 'checking'; adding: boolean }
  | { state: 'downloading' }
  | { state: 'retrying'; retryAt: string };

export interface JobEntryView {
  icon: string;
  title: string;
  named: boolean;
  work: { role: 'check' | 'add'; target: string | null } | { role: 'item'; publisher: string | null };
  status: JobEntryStatus | null;
  progress: { done: number; total: number } | null;
  retry: RetryCauseView | null;
  failure: JobError | null;
}

export function jobEntry(declarations: SourceDeclarations, entry: JobOverviewEntry): JobEntryView {
  const status = statusOf(entry);
  return {
    icon: declarations.get(entry.type)?.icon ?? 'file',
    title: entry.title ?? displayUrl(entry.url),
    named: Boolean(entry.title),
    work: entry.role === 'item' ? { role: 'item', publisher: entry.publisher } : { role: entry.role, target: targetNoun(declarations, entry.type) || null },
    status,
    progress: status && entry.progress?.total ? entry.progress : null,
    retry: entry.status?.state === 'retrying' ? retryCause(declarations, entry.type, entry.status.cause) : null,
    failure: entry.error,
  };
}

function statusOf(entry: JobOverviewEntry): JobEntryStatus | null {
  switch (entry.status?.state) {
    case 'checking': return { state: 'checking', adding: entry.role === 'add' };
    case 'downloading': return { state: 'downloading' };
    case 'retrying': return { state: 'retrying', retryAt: clockTime(entry.status.at) };
    default: return null;
  }
}

export function jobEntryLabel(declarations: SourceDeclarations, entry: JobOverviewEntry): JobEntryLabel {
  const view = jobEntry(declarations, entry);
  return {
    icon: view.icon,
    title: view.title,
    named: view.named,
    subtitle: subtitleText(view.work),
    status: view.status ? { text: statusText(view.status, view.progress), tone: view.status.state === 'retrying' ? 'retrying' : 'collecting' } : null,
    retryReason: view.retry ? retryCauseText(declarations, entry.type, view.retry) : null,
    progress: view.progress,
    reason: view.failure ? failureLabel(declarations, entry.type, view.failure) : null,
  };
}

function subtitleText(work: JobEntryView['work']): string | null {
  if (work.role === 'item') return work.publisher;
  const action = work.role === 'check' ? '檢查' : '新增訂閱';
  return work.target ? `${work.target}・${action}` : action;
}

function statusText(status: JobEntryStatus, progress: JobEntryView['progress']): string {
  switch (status.state) {
    case 'checking': return status.adding ? '新增中' : '檢查中';
    case 'downloading': return progress ? `下載中 ${progress.done}/${progress.total}` : '下載中';
    case 'retrying': return retryAtText(status.retryAt);
  }
}

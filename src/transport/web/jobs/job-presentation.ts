import type { ChannelJobTrigger, JobView } from '../../../shared/jobs/job-types.js';
import { assertNever, roleView } from '../../../shared/jobs/job-role.js';
import type { SourceDeclarations } from '../../../shared/sources/source-registry.js';
import type { SourcePluginDeclaration } from '../../../shared/sources/source-contract.js';
import { triggerLabel } from '../sources/subscription-presentation.js';

function declarationOf(declarations: SourceDeclarations, job: Pick<JobView, 'source'>): SourcePluginDeclaration | undefined {
  return declarations.get(job.source.type);
}

function nounOf(declarations: SourceDeclarations, job: Pick<JobView, 'source'>): string {
  return declarationOf(declarations, job)?.item.noun ?? '';
}

function targetOf(declarations: SourceDeclarations, job: Pick<JobView, 'source'>): string {
  return declarationOf(declarations, job)?.subscription?.targetNoun ?? '';
}

export type JobKindView =
  | { kind: 'item' }
  | { kind: 'check'; trigger: ChannelJobTrigger | null }
  | { kind: 'subscribe' }
  | { kind: 'unregistered' };

export function jobKind(declarations: SourceDeclarations, job: JobView): JobKindView {
  const view = roleView(declarations, job);
  if (view === null) return { kind: 'unregistered' };
  switch (view.role) {
    case 'item': return { kind: 'item' };
    case 'check': return { kind: 'check', trigger: view.trigger };
    case 'add': return { kind: 'subscribe' };
    default: return assertNever(view);
  }
}

export function jobKindLabel(declarations: SourceDeclarations, job: JobView): string {
  const kind = jobKind(declarations, job);
  switch (kind.kind) {
    case 'item': return nounOf(declarations, job);
    case 'check': return triggerLabel(declarations, kind.trigger, job.source.type);
    case 'subscribe': return `訂閱${targetOf(declarations, job)}`;
    case 'unregistered': return job.kind;
  }
}

export function jobTitle(job: JobView): string {
  return job.source.title ?? job.source.url;
}

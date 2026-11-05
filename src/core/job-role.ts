import type { SourceDeclarations } from './source-registry.js';
import type { ChannelJobTrigger, CollectionJob, JobProgress, JobRole } from './job-types.js';
import type { JobEvent } from './activity-types.js';

/**
 * The rules that depend on what a job does: collect one item, check a subscription, or subscribe to
 * an address. Every other module asks this one instead of reading the role off the job kind, so a
 * rule about a role is written once and a switch over `roleView` covers every role.
 *
 * The module holds no Node-only code, so the web build shares it (tests/tooling/web-bundle-node.test.ts).
 */

/** The job fields the role rules read; a job as the HTTP API returns it has all of them. */
export type RoleJob = Pick<CollectionJob, 'kind' | 'source' | 'parentId' | 'scope' | 'progress' | 'result'>;

/**
 * A job as its role sees it. `subscriptionId` of a check is the subscription it checks; of a
 * subscription request, the subscription it subscribed to or is subscribing to, null while it
 * resolves the address.
 */
export type RoleView =
  | { role: 'item'; type: string; key: string | null; parentId: string | null; publisher: string | null }
  | { role: 'check'; type: string; subscriptionId: string | null; trigger: ChannelJobTrigger | null; progress: JobProgress | null }
  | { role: 'add'; type: string; address: string; subscriptionId: string | null; title: string | null };

/** The source type and role of a job kind; null for a kind of an unregistered type or an unknown name. */
function jobRole(sources: SourceDeclarations, kind: string): { type: string; role: JobRole } | null {
  const separator = kind.indexOf('.');
  if (separator < 0) return null;
  const type = kind.slice(0, separator);
  const name = kind.slice(separator + 1);
  const names = sources.get(type)?.jobKindNames;
  if (!names) return null;
  const role = (['item', 'check', 'add'] as const).find((candidate) => names[candidate] === name);
  return role ? { type, role } : null;
}

/** The role of a job kind; null for a kind of an unregistered type. */
export function roleOf(sources: SourceDeclarations, job: Pick<CollectionJob, 'kind'>): JobRole | null {
  return jobRole(sources, job.kind)?.role ?? null;
}

/** The job as its role sees it; null for a job of an unregistered type, which the core keeps but does not run. */
export function roleView(sources: SourceDeclarations, job: RoleJob): RoleView | null {
  const role = roleOf(sources, job);
  if (role === null) return null;
  const type = job.source.type;
  switch (role) {
    case 'item':
      return { role, type, key: job.source.id, parentId: job.parentId, publisher: job.source.publisher ?? null };
    case 'check':
      return { role, type, subscriptionId: job.source.id, trigger: job.scope?.trigger ?? null, progress: job.progress };
    case 'add':
      // The request records its target as its source once it starts subscribing.
      return {
        role, type, address: job.source.url, subscriptionId: job.result?.subscriptionId ?? job.source.id, title: job.source.title,
      };
    default:
      return assertNever(role);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

/**
 * The key that makes two submissions the same work: `<type>:item:<item key>`,
 * `<type>:check:<subscription ID>` or `<type>:add:<address>`, the address compared without case.
 */
export function workKey(type: string, role: JobRole, target: string): string {
  return `${type}:${role}:${role === 'add' ? target.toLowerCase() : target}`;
}

/** The work key of a job; a job of an unregistered type is keyed by its kind and target. */
export function jobKey(sources: SourceDeclarations, job: RoleJob): string {
  const view = roleView(sources, job);
  if (view === null) return `${job.kind}:${job.source.id ?? job.source.url}`;
  switch (view.role) {
    case 'item': return workKey(view.type, 'item', view.key ?? '');
    case 'check': return workKey(view.type, 'check', view.subscriptionId ?? '');
    case 'add': return workKey(view.type, 'add', view.address);
    default: return assertNever(view);
  }
}

/**
 * The subscription a job collects for: the one a check checks, the one a subscription request
 * subscribed to, or for an item, the subscription of the check that queued it. `parentOf` finds the
 * check job.
 */
export function subscriptionOf(sources: SourceDeclarations, job: RoleJob, parentOf: (id: string) => RoleJob | undefined): string | null {
  const view = roleView(sources, job);
  if (view === null) return null;
  switch (view.role) {
    case 'check':
    case 'add':
      return view.subscriptionId;
    case 'item': {
      const parent = view.parentId ? parentOf(view.parentId) : undefined;
      const owner = parent ? roleView(sources, parent) : null;
      return owner?.role === 'check' ? owner.subscriptionId : null;
    }
    default:
      return assertNever(view);
  }
}

/**
 * True for a running job doing its own work: capturing, saving or indexing an item, discovering a
 * subscription's items or resolving a subscription address. A check past discovery only waits for
 * its items. A job of an unregistered type counts as doing its own work in any phase.
 */
export function inOwnStep(sources: SourceDeclarations, job: RoleJob & Pick<CollectionJob, 'state' | 'phase'>): boolean {
  if (job.state !== 'running') return false;
  const role = roleOf(sources, job);
  switch (role) {
    case 'item': return job.phase === 'capture' || job.phase === 'save' || job.phase === 'index';
    case 'check': return job.phase === 'discover';
    case 'add': return job.phase === 'resolve';
    case null: return job.phase !== null;
    default: return assertNever(role);
  }
}

/**
 * A top-level job the user can retry: a failed one, or a check job that completed with some of its
 * items failing.
 */
export function isRetryable(sources: SourceDeclarations, job: Pick<CollectionJob, 'state' | 'kind' | 'parentId' | 'result'>): boolean {
  if (job.parentId !== null) return false;
  return job.state === 'failed' || (roleOf(sources, job) === 'check' && job.state === 'completed' && job.result?.outcome === 'partial');
}

/** The fields every event of a job carries. */
export type JobEventSubject = Pick<JobEvent,
  'vaultPath' | 'vaultId' | 'jobId' | 'jobRole' | 'sourceType' | 'sourceId' | 'sourceTitle' | 'subscriptionId' | 'parentJobId' | 'trigger'>;

/**
 * What an event of `job` records about the job when it is written: its Vault, role, source,
 * subscription, parent and trigger. Events outlive job records, so the activity view filters and
 * groups them by these fields alone.
 */
export function jobEventSubject(
  sources: SourceDeclarations, job: RoleJob & Pick<CollectionJob, 'id' | 'vaultPath' | 'vaultId'>, parentOf: (id: string) => RoleJob | undefined,
): JobEventSubject {
  const role = roleOf(sources, job);
  const subscriptionId = subscriptionOf(sources, job, parentOf);
  return {
    vaultPath: job.vaultPath, ...(job.vaultId ? { vaultId: job.vaultId } : {}), jobId: job.id,
    ...(role ? { jobRole: role } : {}),
    sourceType: job.source.type,
    ...(job.source.id ? { sourceId: job.source.id } : {}),
    ...(job.source.title ? { sourceTitle: job.source.title } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(job.parentId ? { parentJobId: job.parentId } : {}),
    ...(job.scope ? { trigger: job.scope.trigger } : {}),
  };
}

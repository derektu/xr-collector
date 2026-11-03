import type { ActivityGroupPage, ActivityQuery } from '../core/types.js';

/** One read of a check group's detail: up to `limit` checks after `cursor`, with events at `severity`. */
export type GroupPageReader = (groupId: string, query: { limit: number; cursor?: string; severity?: ActivityQuery['severity'] }) => Promise<ActivityGroupPage>;

export interface GroupPagesState {
  page: ActivityGroupPage | null;
  error: string | null;
  loading: boolean;
}

const PAGE = 10;

/**
 * The checks of one activity group as its detail screen shows them: the first ten, then ten more
 * for each `older()`. Showing the group at other levels reads it again with as many checks as were
 * loaded, so the reader keeps their place; another group starts at ten. An answer to a request made
 * before the group or the levels changed is dropped, so a delayed older page never mixes into
 * checks read at other levels.
 */
export class ActivityGroupPages {
  private state: GroupPagesState = { page: null, error: null, loading: false };
  private generation = 0;
  private groupId: string | null = null;
  private severity: ActivityQuery['severity'];
  private loaded = PAGE;

  constructor(private readonly read: GroupPageReader, private readonly onChange: (state: GroupPagesState) => void) {}

  current(): GroupPagesState {
    return this.state;
  }

  /** Shows `groupId` with events at `severity`, from its newest check. */
  async show(groupId: string, severity: ActivityQuery['severity']): Promise<void> {
    const generation = ++this.generation;
    if (this.groupId !== groupId) { this.groupId = groupId; this.loaded = PAGE; }
    this.severity = severity;
    this.set({ page: null, error: null, loading: false });
    try {
      const page = await this.checks(groupId, severity, this.loaded);
      if (generation === this.generation) this.set({ ...this.state, page });
    } catch (reason) {
      if (generation === this.generation) this.set({ ...this.state, error: reason instanceof Error ? reason.message : '無法讀取檢查細節。' });
    }
  }

  /** Adds the next ten older checks to the shown page. */
  async older(): Promise<void> {
    const shown = this.state.page;
    const groupId = this.groupId;
    if (!shown?.nextCursor || groupId === null) return;
    const generation = this.generation;
    const cursor = shown.nextCursor;
    this.set({ ...this.state, loading: true });
    try {
      const next = await this.read(groupId, { limit: PAGE, cursor, severity: this.severity });
      const current = this.state.page;
      if (generation !== this.generation || !current || current.nextCursor !== cursor) return;
      this.loaded += next.checks.length;
      this.set({ ...this.state, page: { ...next, checks: [...current.checks, ...next.checks] } });
    } catch (reason) {
      if (generation === this.generation) this.set({ ...this.state, error: reason instanceof Error ? reason.message : '無法讀取更早的檢查。' });
    } finally {
      if (generation === this.generation) this.set({ ...this.state, loading: false });
    }
  }

  /** Drops every answer still on its way, for a screen that went away. */
  close(): void {
    this.generation += 1;
  }

  /** The newest `target` checks, read in pages of at most 100. */
  private async checks(groupId: string, severity: ActivityQuery['severity'], target: number): Promise<ActivityGroupPage> {
    let answer = await this.read(groupId, { limit: Math.min(100, target), severity });
    while (answer.checks.length < target && answer.nextCursor) {
      const next = await this.read(groupId, { limit: Math.min(100, target - answer.checks.length), cursor: answer.nextCursor, severity });
      answer = { ...next, checks: [...answer.checks, ...next.checks] };
    }
    return answer;
  }

  private set(state: GroupPagesState): void {
    this.state = state;
    this.onChange(state);
  }
}

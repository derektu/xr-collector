// The detail of a group of routine checks loads ten checks at a time. Without these rules an older
// page requested at one level lands after the reader switched levels and mixes checks read at the
// old level into the new list, or switching levels throws away the checks the reader had loaded.
import { describe, expect, it } from 'vitest';
import { ActivityGroupPages, type GroupPageReader, type GroupPagesState } from '../../src/web/activity-group-pages.js';
import type { ActivityCheckDetail, ActivityCheckSummary, ActivityGroupPage, ActivityQuery } from '../../src/core/types.js';

const TOTAL = 12;

function check(index: number, severity: ActivityQuery['severity']): ActivityCheckDetail {
  return { jobId: `check-${index}`, severity: severity?.join(',') ?? 'all' } as unknown as ActivityCheckDetail;
}

/** A group of twelve checks whose reads wait until the test answers them, in the order it chooses. */
function heldGroup() {
  const pending: Array<{ query: Parameters<GroupPageReader>[1]; answer: () => void }> = [];
  const read: GroupPageReader = (groupId, query) => new Promise<ActivityGroupPage>((resolve) => {
    const start = query.cursor ? Number(query.cursor) : 0;
    const end = Math.min(TOTAL, start + query.limit);
    pending.push({ query, answer: () => resolve({
      group: { groupId, count: TOTAL } as ActivityCheckSummary,
      checks: Array.from({ length: end - start }, (_, offset) => check(start + offset, query.severity)),
      nextCursor: end < TOTAL ? String(end) : null,
      retentionDays: 30,
    }) });
  });
  const states: GroupPagesState[] = [];
  const pages = new ActivityGroupPages(read, (state) => states.push(state));
  /** Answers the oldest request still waiting. */
  const answerNext = () => pending.shift()!.answer();
  return { pages, pending, answerNext, states };
}

const levels = (pages: ActivityGroupPages) => pages.current().page?.checks.map((entry) => (entry as unknown as { severity: string }).severity);

describe('activity group detail pages', () => {
  it('drops an older page requested at the previous level when it arrives after the switch', async () => {
    const { pages, pending, answerNext } = heldGroup();
    const first = pages.show('group', ['info', 'warning', 'error']);
    answerNext();
    await first;
    expect(pages.current().page?.checks).toHaveLength(10);

    const older = pages.older();
    const switched = pages.show('group', ['error']);
    expect(pending.map((entry) => entry.query.severity)).toEqual([['info', 'warning', 'error'], ['error']]);
    // The new level answers first; the older page at the old level arrives late.
    pending.push(pending.shift()!);
    answerNext();
    await switched;
    answerNext();
    await older;

    expect(pages.current().page?.checks).toHaveLength(10);
    expect(new Set(levels(pages))).toEqual(new Set(['error']));
    expect(pages.current().loading).toBe(false);
  });

  it('keeps the loaded count when the level changes and starts at ten for another group', async () => {
    const { pages, answerNext, pending } = heldGroup();
    const first = pages.show('group', ['info']);
    answerNext();
    await first;
    const older = pages.older();
    answerNext();
    await older;
    expect(pages.current().page?.checks).toHaveLength(TOTAL);
    expect(pages.current().page?.nextCursor).toBeNull();

    const switched = pages.show('group', ['error']);
    expect(pending[0]!.query.limit).toBe(TOTAL);
    answerNext();
    await switched;
    expect(pages.current().page?.checks).toHaveLength(TOTAL);

    void pages.show('other', ['error']);
    expect(pending[0]!.query.limit).toBe(10);
  });

  it('ignores answers that arrive after the screen closed', async () => {
    const { pages, answerNext, states } = heldGroup();
    const shown = pages.show('group', ['info']);
    pages.close();
    const before = states.length;
    answerNext();
    await shown;
    expect(states).toHaveLength(before);
    expect(pages.current().page).toBeNull();
  });
});

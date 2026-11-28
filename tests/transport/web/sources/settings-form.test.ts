// Broken, saving subscription settings sends fields the user did not change, or drops an edit made after the last save.
import { describe, expect, it } from 'vitest';
import { editSettingsForm, openSettingsForm, takeUnsent } from '../../../../src/transport/web/sources/settings-form.js';

const opened = { intervalMinutes: 60, backfillDays: 7, backfillMaxItems: 30, documentStatus: 'published' as const };

describe('a save sends only the fields the user changed since the last save', () => {
  it.each([
    { rule: 'nothing edited sends nothing', saves: [[]], patch: {} },
    { rule: 'an untouched field is not sent with an edited one', saves: [[{ backfillMaxItems: 25 }]], patch: { backfillMaxItems: 25 } },
    { rule: 'fields edited before one save are sent together', saves: [[{ backfillDays: 2 }, { backfillMaxItems: 25 }]], patch: { backfillDays: 2, backfillMaxItems: 25 } },
    { rule: 'a field already sent is not sent again', saves: [[{ intervalMinutes: 30 }], [{ backfillDays: 2 }]], patch: { backfillDays: 2 } },
    { rule: 'a field changed back to its opened value after a save is sent', saves: [[{ backfillDays: 2 }], [{ backfillDays: 7 }]], patch: { backfillDays: 7 } },
    { rule: 'a field edited back before saving sends nothing', saves: [[{ backfillDays: 2 }, { backfillDays: 7 }]], patch: {} },
  ])('$rule', ({ saves, patch }) => {
    let form = openSettingsForm('rss:a', opened);
    let last = {};
    for (const edits of saves) {
      for (const edit of edits) form = editSettingsForm(form, edit);
      ({ form, patch: last } = takeUnsent(form));
    }
    expect(last).toEqual(patch);
  });

  it('a save keeps the fields as the user typed them', () => {
    const edited = editSettingsForm(openSettingsForm('rss:a', opened), { backfillDays: 2 });
    expect(takeUnsent(edited).form.shown).toEqual({ ...opened, backfillDays: 2 });
  });
});

// Guards the developer, not the user: the event catalog (`src/core/event-catalog.ts`) lists every kind
// of event and how the activity summary shows it. An emitter or reader that names a kind the catalog
// does not list fails the typecheck, so a new event cannot reach the log, or a branch on a misspelled
// kind slip through, without its catalog entry.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventSpec } from '../../src/core/event-catalog.js';

describe('event catalog', () => {
  it('refuses an event kind the catalog does not list', () => {
    // tests/tooling/fixtures/event-catalog-types marks each refused kind with `@ts-expect-error`.
    const result = spawnSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tests/tooling/fixtures/event-catalog-types'], { encoding: 'utf8' });
    expect(`${result.stdout}${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  });

  it('answers for a pacing group of any name, and for no unlisted kind', () => {
    expect(eventSpec('fake.rate_limited')).toMatchObject({ severity: 'warning', summary: true, child: false });
    expect(eventSpec('fake.cooldown_ended')).toMatchObject({ severity: 'info' });
    expect(eventSpec('rate_limited')).toBeNull();
    expect(eventSpec('document.archived')).toBeNull();
    expect(eventSpec('toString')).toBeNull();
  });
});

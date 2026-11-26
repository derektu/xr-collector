// Guards the developer, not the user: a new or misspelled event kind reaches the log without a catalog entry.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventSpec } from '../../src/shared/activity/event-catalog.js';

describe('event catalog', () => {
  it('refuses an event kind the catalog does not list', () => {
    const result = spawnSync(process.execPath, [path.resolve('node_modules/typescript-7/bin/tsc'), '-p', 'tests/tooling/fixtures/event-catalog-types'], { encoding: 'utf8' });
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

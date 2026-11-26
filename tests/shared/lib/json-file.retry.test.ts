// External: On Windows, renaming over a file that another process holds open without delete sharing fails with
// EPERM; antivirus and indexing scans open a file just written this way for a short time.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { replaceFile } from '../../../src/shared/lib/json-file.js';

const target = vi.hoisted(() => ({ heldUntil: 0, failure: null as string | null, renames: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  rename: async () => {
    target.renames += 1;
    if (target.failure) throw Object.assign(new Error(target.failure), { code: target.failure });
    if (Date.now() < target.heldUntil) throw Object.assign(new Error(`EPERM ${target.renames}`), { code: 'EPERM' });
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(target, { heldUntil: 0, failure: null, renames: 0 });
});
afterEach(() => { vi.useRealTimers(); });

it('replaces the file once a hold shorter than the retry limit ends', async () => {
  target.heldUntil = Date.now() + 1_000;
  const replacing = replaceFile('state.json.tmp', 'state.json');

  await vi.advanceTimersByTimeAsync(1_000);

  await expect(replacing).resolves.toBeUndefined();
});

it('throws the last EPERM when the hold outlasts the retry limit', async () => {
  target.heldUntil = Number.POSITIVE_INFINITY;
  const failure = replaceFile('state.json.tmp', 'state.json').catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(1_270);

  expect(await failure).toMatchObject({ code: 'EPERM', message: `EPERM ${target.renames}` });
  expect(target.renames).toBeGreaterThan(1);
});

it('throws any other rename error at once', async () => {
  target.failure = 'ENOSPC';

  await expect(replaceFile('state.json.tmp', 'state.json')).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(target.renames).toBe(1);
});

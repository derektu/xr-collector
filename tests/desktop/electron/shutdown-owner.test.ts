import { expect, it } from 'vitest';
import { beforeQuitAction } from '../../../src/desktop/electron/shutdown-owner.js';

const runtime = { name: 'runtime' };

it('ignores a menu or OS quit once the update owns shutdown, so the install handoff is not skipped', () => {
  expect(beforeQuitAction('update', runtime)).toEqual({ kind: 'wait-for-update' });
});

it('holds the first quit until the runtime has closed, so collection and the Vault stop cleanly before the process ends', () => {
  expect(beforeQuitAction('none', runtime)).toEqual({ kind: 'close-runtime-first', runtime });
});

it('lets the quit through once no runtime is open, so the quit that ends a finished shutdown is not held again', () => {
  expect(beforeQuitAction('update', null)).toEqual({ kind: 'quit' });
  expect(beforeQuitAction('none', null)).toEqual({ kind: 'quit' });
});

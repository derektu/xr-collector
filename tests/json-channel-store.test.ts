import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonChannelStore } from '../src/channels/json-channel-store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('JsonChannelStore', () => {
  it('persists channel additions, enabled changes, and removals across instances', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xr-collector-channels-'));
    temporaryRoots.push(root);
    const first = new JsonChannelStore(root);

    await first.add({
      id: 'UC1234567890',
      title: '第一個頻道',
      url: 'https://www.youtube.com/channel/UC1234567890/videos',
      enabled: true,
      addedAt: '2026-09-17T00:00:00.000Z',
    });
    await first.setEnabled('UC1234567890', false);

    const restarted = new JsonChannelStore(root);
    expect(await restarted.list()).toEqual([
      expect.objectContaining({ id: 'UC1234567890', enabled: false }),
    ]);

    await restarted.remove('UC1234567890');
    expect(await new JsonChannelStore(root).list()).toEqual([]);
  });
});

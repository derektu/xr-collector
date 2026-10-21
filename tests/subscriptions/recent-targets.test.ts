import { describe, expect, it } from 'vitest';
import { RecentTargets } from '../../src/subscriptions/recent-targets.js';

const target = { id: 'UC-one', title: '頻道', url: 'https://example.test/one' };

describe('RecentTargets', () => {
  it('keeps a target by type and address until it expires', () => {
    let now = 0;
    const targets = new RecentTargets(1000, () => now);
    targets.remember('youtube', 'https://www.youtube.com/@one', target);

    expect(targets.get('youtube', 'https://www.youtube.com/@one')).toEqual(target);
    expect(targets.get('fake', 'https://www.youtube.com/@one')).toBeUndefined();
    expect(targets.get('youtube', 'https://www.youtube.com/@two')).toBeUndefined();
    now = 999;
    expect(targets.get('youtube', 'https://www.youtube.com/@one')).toEqual(target);
    now = 1000;
    expect(targets.get('youtube', 'https://www.youtube.com/@one')).toBeUndefined();
  });
});

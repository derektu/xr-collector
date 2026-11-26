// Broken, an update installer could be swapped in transit or leak credentials.
import { expect, it } from 'vitest';
import { updateFeedUrl } from '../../../src/domain/updates/index.js';

it.each([
  ['https://updates.example.com/xr/', true],
  ['http://127.0.0.1:7322/', true],
  ['http://localhost:7322/feed/', true],
  ['http://updates.example.com/xr/', false],
  ['https://user:secret@updates.example.com/', false],
  ['https://updates.example.com/?channel=beta', false],
  ['https://updates.example.com/#latest', false],
  ['file:///Users/me/feed/', false],
])('accepts %s as an update feed: %s', (url, accepted) => {
  if (accepted) expect(updateFeedUrl(url)).toBe(url);
  else expect(() => updateFeedUrl(url)).toThrow();
});

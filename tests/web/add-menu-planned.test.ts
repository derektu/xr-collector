import { describe, expect, it } from 'vitest';
import { registerSourceDeclarations } from '../../src/core/source-registry.js';
import { addDialogTitles, addPlaceholder, subscriptionAddItems } from '../../src/web/add-menu.js';
import { fakeDefinition } from '../support/fake-source-plugin.js';

// A plugin registered under the ID of a planned subscription type stands where its placeholder stood.

registerSourceDeclarations([fakeDefinition('facebook', 'facebook-net')]);

describe('a planned subscription type that a plugin provides', () => {
  it('replaces the placeholder in its place, once', () => {
    expect(subscriptionAddItems().map((item) => [item.label, item.mode])).toEqual([
      ['YouTube 頻道', 'youtube-channel'], ['RSS', 'rss-feed'], ['X 帳號', null], ['facebook 動態', 'facebook-feed'],
    ]);
    expect(addDialogTitles()).toEqual({
      url: '加入網址', 'youtube-channel': '訂閱 YouTube 頻道', 'rss-feed': '訂閱 RSS', 'facebook-feed': '訂閱 facebook 動態',
    });
    // With two types adding single items, the URL dialog names neither.
    expect(addPlaceholder('url')).toBe('貼上網址');
    expect(addPlaceholder('facebook-feed')).toBe('貼上 facebook 動態網址');
  });
});

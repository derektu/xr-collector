import { describe, expect, it } from 'vitest';
import type { UrlRecognition } from '../../src/core/types.js';
import {
  ADD_DIALOG_TITLES,
  addMismatch,
  DOCUMENT_ADD_ITEMS,
  isUnsupportedUrl,
  menuIndexForKey,
  SUBSCRIPTION_ADD_ITEMS,
  UNSUPPORTED_URL,
  unsupportedText,
} from '../../src/web/add-menu.js';

function recognition(overrides: Partial<UrlRecognition>): UrlRecognition {
  return {
    status: 'ready', sourceType: 'youtube', kind: null, kindLabel: null, url: 'https://www.youtube.com/@a', target: null,
    subscription: null, settings: null, autoCollection: null, actions: [], login: null, message: null, ...overrides,
  };
}

describe('add menus (N75-T2)', () => {
  it('lists every item of both menus and marks the ones not supported yet', () => {
    expect(DOCUMENT_ADD_ITEMS.map((item) => [item.label, item.mode])).toEqual([['網址', 'url'], ['檔案', null], ['寫筆記', null]]);
    expect(SUBSCRIPTION_ADD_ITEMS.map((item) => [item.label, item.mode])).toEqual([
      ['YouTube 頻道', 'youtube-channel'], ['X 帳號', null], ['Facebook 粉專', null], ['RSS', null],
    ]);
    expect(ADD_DIALOG_TITLES).toEqual({ url: '加入網址', 'youtube-channel': '訂閱 YouTube 頻道' });
  });

  it('names the unsupported dialog after its item', () => {
    const dialog = (items: typeof DOCUMENT_ADD_ITEMS, id: string) => {
      const item = items.find((candidate) => candidate.id === id)!;
      return [item.dialogTitle, unsupportedText(item)];
    };
    expect(dialog(SUBSCRIPTION_ADD_ITEMS, 'facebook')).toEqual(['訂閱 Facebook 粉專', '目前還不支援 Facebook 粉專。']);
    expect(dialog(SUBSCRIPTION_ADD_ITEMS, 'x')).toEqual(['訂閱 X 帳號', '目前還不支援 X 帳號。']);
    expect(dialog(SUBSCRIPTION_ADD_ITEMS, 'rss')).toEqual(['訂閱 RSS', '目前還不支援 RSS。']);
    expect(dialog(DOCUMENT_ADD_ITEMS, 'file')).toEqual(['加入檔案', '目前還不支援檔案。']);
    expect(dialog(DOCUMENT_ADD_ITEMS, 'note')).toEqual(['寫筆記', '目前還不支援寫筆記。']);
  });

  it('moves through the menu with wrapping arrows and jumps with Home and End', () => {
    expect(menuIndexForKey('ArrowDown', -1, 4)).toBe(0);
    expect(menuIndexForKey('ArrowDown', 3, 4)).toBe(0);
    expect(menuIndexForKey('ArrowUp', 0, 4)).toBe(3);
    expect(menuIndexForKey('Home', 2, 4)).toBe(0);
    expect(menuIndexForKey('End', 0, 4)).toBe(3);
    expect(menuIndexForKey('ArrowRight', 0, 4)).toBeNull();
  });
});

describe('add dialog mismatch (N75-T3)', () => {
  const channel = recognition({ kind: 'channel', kindLabel: 'YouTube 頻道' });
  const video = recognition({ kind: 'video', kindLabel: 'YouTube 影片' });

  it('offers the other dialog when the address is of the other kind', () => {
    expect(addMismatch('url', channel)).toEqual({ message: '這是 YouTube 頻道，要改為訂閱嗎？', action: '改為訂閱', switchTo: 'youtube-channel' });
    expect(addMismatch('youtube-channel', video)).toEqual({ message: '這是單支影片，要改為加入一次嗎？', action: '改為加入一次', switchTo: 'url' });
  });

  it('offers the switch for a channel whose preview a YouTube cooldown made unavailable', () => {
    const cooling = recognition({ status: 'unavailable', kind: 'channel', kindLabel: 'YouTube 頻道', message: 'YouTube 暫時限制連線。' });
    expect(addMismatch('url', cooling)?.switchTo).toBe('youtube-channel');
  });

  it('says nothing when the kind matches the dialog', () => {
    expect(addMismatch('url', video)).toBeNull();
    expect(addMismatch('youtube-channel', channel)).toBeNull();
  });

  it('reports an address no source type owns as unsupported', () => {
    const page = recognition({ status: 'unsupported', sourceType: null, url: 'https://example.com/post', message: '目前還不支援這個網站的網址。' });
    expect(addMismatch('url', page)).toBeNull();
    expect(isUnsupportedUrl(page)).toBe(true);
    expect(UNSUPPORTED_URL).toBe('目前還不支援這個網址。');
    expect(isUnsupportedUrl(video)).toBe(false);
    // A YouTube address the type recognizes but cannot use explains itself instead.
    expect(isUnsupportedUrl(recognition({ status: 'unsupported', sourceType: 'youtube', message: '不是有效的 YouTube 網址。' }))).toBe(false);
  });
});

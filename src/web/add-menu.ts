import type { UrlRecognition } from '../core/types.js';

/** The add dialogs that exist: one item from a URL, and a YouTube channel subscription. */
export type AddMode = 'url' | 'youtube-channel';

/** One entry of an add menu. */
export interface AddMenuItem {
  id: string;
  label: string;
  /** Title of the dialog the item opens, also for the dialog saying it is not supported yet. */
  dialogTitle: string;
  /** The add dialog it opens; null while the item is not supported yet. */
  mode: AddMode | null;
}

/** The Documents page's 新增 menu: each item adds one document that is not updated later. */
export const DOCUMENT_ADD_ITEMS: readonly AddMenuItem[] = [
  { id: 'url', label: '網址', dialogTitle: '加入網址', mode: 'url' },
  { id: 'file', label: '檔案', dialogTitle: '加入檔案', mode: null },
  { id: 'note', label: '寫筆記', dialogTitle: '寫筆記', mode: null },
];

/** The Subscriptions page's 新增訂閱 menu: each item adds a subscription that is checked for new items. */
export const SUBSCRIPTION_ADD_ITEMS: readonly AddMenuItem[] = [
  { id: 'youtube-channel', label: 'YouTube 頻道', dialogTitle: '訂閱 YouTube 頻道', mode: 'youtube-channel' },
  { id: 'x', label: 'X 帳號', dialogTitle: '訂閱 X 帳號', mode: null },
  { id: 'facebook', label: 'Facebook 粉專', dialogTitle: '訂閱 Facebook 粉專', mode: null },
  { id: 'rss', label: 'RSS', dialogTitle: '訂閱 RSS', mode: null },
];

export const ADD_DIALOG_TITLES: Record<AddMode, string> = { url: '加入網址', 'youtube-channel': '訂閱 YouTube 頻道' };

/** The body of the dialog an unsupported item opens. */
export function unsupportedText(item: Pick<AddMenuItem, 'label'>): string {
  // A Latin name is set off from the Chinese text by a space, as in 「目前還不支援 RSS。」.
  return `目前還不支援${/^[A-Za-z]/u.test(item.label) ? ' ' : ''}${item.label}。`;
}

/** A pasted address of the other kind than the dialog adds, with the switch that fixes it. */
export interface AddMismatch {
  message: string;
  action: string;
  switchTo: AddMode;
}

/**
 * Whether the recognized address belongs in the other add dialog. Only the kind decides, so a
 * channel whose preview is unavailable, such as during a YouTube cooldown, still offers the switch.
 */
export function addMismatch(mode: AddMode, recognition: Pick<UrlRecognition, 'kind'>): AddMismatch | null {
  if (mode === 'url' && recognition.kind === 'channel') {
    return { message: '這是 YouTube 頻道，要改為訂閱嗎？', action: '改為訂閱', switchTo: 'youtube-channel' };
  }
  if (mode === 'youtube-channel' && recognition.kind === 'video') {
    return { message: '這是單支影片，要改為加入一次嗎？', action: '改為加入一次', switchTo: 'url' };
  }
  return null;
}

/** An address no source type owns. */
export const UNSUPPORTED_URL = '目前還不支援這個網址。';

/** Whether the address belongs to no source type, so no dialog can add it. */
export function isUnsupportedUrl(recognition: Pick<UrlRecognition, 'status' | 'sourceType'>): boolean {
  return recognition.status === 'unsupported' && recognition.sourceType === null;
}

/**
 * Menu keyboard movement (WAI-ARIA menu): arrows move to the next or previous item and wrap
 * around, Home and End jump to the ends. Returns null for keys the menu does not move with.
 */
export function menuIndexForKey(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

import { sourceDeclaration, sourceDeclarations } from '../core/source-registry.js';
import type { SourceKindInfo, UrlRecognition } from '../core/types.js';
import type { SourcePluginDeclaration } from '../plugins/types.js';

/**
 * The add dialogs that exist: `url` adds one item from a URL, and `<type>-<kind>` subscribes with a
 * source type's subscription kind, e.g. a channel.
 */
export type AddMode = string;

/** A source type's subscription kind, with the add dialog that subscribes with it. */
interface SubscriptionKind {
  declaration: SourcePluginDeclaration;
  kind: SourceKindInfo;
  mode: AddMode;
}

/** Every registered subscription kind, in registration order. */
function subscriptionKinds(): SubscriptionKind[] {
  return sourceDeclarations().flatMap((declaration) => declaration.kinds
    .filter((kind) => kind.capability === 'subscription')
    .map((kind) => ({ declaration, kind, mode: `${declaration.id}-${kind.id}` })));
}

/** The subscription kind an add dialog subscribes with; undefined for the URL dialog. */
export function subscriptionKindOf(mode: AddMode): SubscriptionKind | undefined {
  return subscriptionKinds().find((candidate) => candidate.mode === mode);
}

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

/**
 * Subscription types the menu shows before any plugin offers them, by the source type ID a plugin
 * for them would register, in menu order. A registered type with the same ID takes its place.
 */
export const PLANNED_SUBSCRIPTION_TYPES: readonly { type: string; label: string }[] = [
  { type: 'x', label: 'X 帳號' },
  { type: 'facebook', label: 'Facebook 粉專' },
];

/** The menu item of a registered subscription kind. */
function kindItem({ kind, mode }: SubscriptionKind): AddMenuItem {
  return { id: mode, label: kind.label, dialogTitle: `訂閱 ${kind.label}`, mode };
}

/**
 * The Subscriptions page's 新增訂閱 menu: each item adds a subscription that is checked for new
 * items. Registered kinds come first, except those of a planned type, which stand where the planned
 * type does; a planned type no plugin registers opens the dialog saying it is not supported yet.
 */
export function subscriptionAddItems(): AddMenuItem[] {
  const kinds = subscriptionKinds();
  const planned = new Set(PLANNED_SUBSCRIPTION_TYPES.map((entry) => entry.type));
  return [
    ...kinds.filter(({ declaration }) => !planned.has(declaration.id)).map(kindItem),
    ...PLANNED_SUBSCRIPTION_TYPES.flatMap(({ type, label }) => {
      const offered = kinds.filter(({ declaration }) => declaration.id === type);
      return offered.length > 0 ? offered.map(kindItem) : [{ id: type, label, dialogTitle: `訂閱 ${label}`, mode: null }];
    }),
  ];
}

/** The title of each add dialog. */
export function addDialogTitles(): Record<AddMode, string> {
  return { url: '加入網址', ...Object.fromEntries(subscriptionKinds().map(({ kind, mode }) => [mode, `訂閱 ${kind.label}`])) };
}

/**
 * The hint an add dialog's address field shows: for a subscription, its kind's own; for the URL
 * dialog, that of the one type that adds single items, or a general one when several do.
 */
export function addPlaceholder(mode: AddMode): string {
  const subscription = subscriptionKindOf(mode);
  if (subscription) return subscription.declaration.prompts.subscriptionPlaceholder;
  const single = sourceDeclarations().filter((declaration) => declaration.kinds.some((kind) => kind.capability === 'single'));
  return single.length === 1 ? single[0]!.prompts.itemPlaceholder : '貼上網址';
}

/** The body of the dialog an unsupported item opens. */
export function unsupportedText(item: Pick<AddMenuItem, 'label'>): string {
  // A Latin name is set off from the Chinese text by a space, as in 「目前還不支援 X 帳號。」.
  return `目前還不支援${/^[A-Za-z]/u.test(item.label) ? ' ' : ''}${item.label}。`;
}

/** A pasted address of the other kind than the dialog adds, with the switch that fixes it. */
export interface AddMismatch {
  message: string;
  action: string;
  switchTo: AddMode;
}

/**
 * Whether the recognized address belongs in the other add dialog. The kind decides, so a
 * subscription address whose preview is unavailable, such as during a source's cooldown, still
 * offers the switch; an address its type found is no target of that kind offers none.
 */
export function addMismatch(mode: AddMode, recognition: Pick<UrlRecognition, 'kind'> & Partial<Pick<UrlRecognition, 'sourceType' | 'status'>>): AddMismatch | null {
  if (!recognition.kind || recognition.status === 'unsupported') return null;
  const owner = recognition.sourceType ? sourceDeclaration(recognition.sourceType) : undefined;
  const declarations = owner ? [owner] : sourceDeclarations();
  const found = declarations.flatMap((declaration) => declaration.kinds
    .filter((kind) => kind.id === recognition.kind).map((kind) => ({ declaration, kind })))[0];
  if (!found) return null;
  const { declaration, kind } = found;
  if (mode === 'url' && kind.capability === 'subscription') {
    return { message: `這是 ${kind.label}，要改為訂閱嗎？`, action: '改為訂閱', switchTo: `${declaration.id}-${kind.id}` };
  }
  if (mode !== 'url' && kind.capability === 'single') {
    return { message: `這是單${declaration.item.measure}${declaration.item.noun}，要改為加入一次嗎？`, action: '改為加入一次', switchTo: 'url' };
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

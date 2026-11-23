import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import type { SourceKindInfo, UrlRecognition } from '../../shared/sources/source-info-types.js';
import type { SourcePluginDeclaration } from '../../shared/sources/source-contract.js';

export type AddMode = 'url' | `${string}-${string}`;

interface SubscriptionKind {
  declaration: SourcePluginDeclaration;
  kind: SourceKindInfo;
  mode: AddMode;
}

function subscriptionKinds(declarations: SourceDeclarations): SubscriptionKind[] {
  return declarations.list.flatMap((declaration) => declaration.kinds
    .filter((kind) => kind.capability === 'subscription')
    .map((kind) => ({ declaration, kind, mode: `${declaration.id}-${kind.id}` })));
}

export function subscriptionKindOf(declarations: SourceDeclarations, mode: AddMode): SubscriptionKind | undefined {
  return subscriptionKinds(declarations).find((candidate) => candidate.mode === mode);
}

export interface AddMenuItem {
  id: string;
  label: string;
  dialogTitle: string;
  mode: AddMode | null;
}

export const DOCUMENT_ADD_ITEMS: readonly AddMenuItem[] = [
  { id: 'url', label: '網址', dialogTitle: '加入網址', mode: 'url' },
  { id: 'file', label: '檔案', dialogTitle: '加入檔案', mode: null },
  { id: 'note', label: '寫筆記', dialogTitle: '寫筆記', mode: null },
];

export const PLANNED_SUBSCRIPTION_TYPES: readonly { type: string; label: string }[] = [
  { type: 'x', label: 'X 帳號' },
  { type: 'facebook', label: 'Facebook 粉專' },
];

function kindItem({ kind, mode }: SubscriptionKind): AddMenuItem {
  return { id: mode, label: kind.label, dialogTitle: `訂閱 ${kind.label}`, mode };
}

export function subscriptionAddItems(declarations: SourceDeclarations): AddMenuItem[] {
  const kinds = subscriptionKinds(declarations);
  const planned = new Set(PLANNED_SUBSCRIPTION_TYPES.map((entry) => entry.type));
  return [
    ...kinds.filter(({ declaration }) => !planned.has(declaration.id)).map(kindItem),
    ...PLANNED_SUBSCRIPTION_TYPES.flatMap(({ type, label }) => {
      const offered = kinds.filter(({ declaration }) => declaration.id === type);
      return offered.length > 0 ? offered.map(kindItem) : [{ id: type, label, dialogTitle: `訂閱 ${label}`, mode: null }];
    }),
  ];
}

export function addDialogTitles(declarations: SourceDeclarations): Record<AddMode, string> {
  return { url: '加入網址', ...Object.fromEntries(subscriptionKinds(declarations).map(({ kind, mode }) => [mode, `訂閱 ${kind.label}`])) };
}

export function addPlaceholder(declarations: SourceDeclarations, mode: AddMode): string {
  const subscription = subscriptionKindOf(declarations, mode);
  if (subscription) return subscription.declaration.prompts.subscriptionPlaceholder;
  const single = declarations.list.filter((declaration) => declaration.kinds.some((kind) => kind.capability === 'single'));
  const [only, ...others] = single;
  return only && others.length === 0 ? only.prompts.itemPlaceholder : '貼上網址';
}

export function unsupportedText(item: Pick<AddMenuItem, 'label'>): string {
  return `目前還不支援${/^[A-Za-z]/u.test(item.label) ? ' ' : ''}${item.label}。`;
}

export interface AddMismatch {
  message: string;
  action: string;
  switchTo: AddMode;
}

export function addMismatch(declarations: SourceDeclarations, mode: AddMode, recognition: Pick<UrlRecognition, 'kind'> & Partial<Pick<UrlRecognition, 'sourceType' | 'status'>>): AddMismatch | null {
  if (!recognition.kind || recognition.status === 'unsupported') return null;
  const owner = recognition.sourceType ? declarations.get(recognition.sourceType) : undefined;
  const candidates = owner ? [owner] : declarations.list;
  const found = candidates.flatMap((declaration) => declaration.kinds
    .filter((kind) => kind.id === recognition.kind).map((kind) => ({ declaration, kind })))[0];
  if (!found) return null;
  const { declaration, kind } = found;
  if (mode === 'url' && kind.capability === 'subscription') {
    return { message: `這是 ${kind.label}，要改為訂閱嗎？`, action: '改為訂閱', switchTo: `${declaration.id}-${kind.id}` };
  }
  if (mode !== 'url' && kind.capability === 'single') {
    return { message: `這是單${declaration.item.measureWord}${declaration.item.noun}，要改為加入一次嗎？`, action: '改為加入一次', switchTo: 'url' };
  }
  return null;
}

export const UNSUPPORTED_URL = '目前還不支援這個網址。';

export function isUnsupportedUrl(recognition: Pick<UrlRecognition, 'status' | 'sourceType'>): boolean {
  return recognition.status === 'unsupported' && recognition.sourceType === null;
}

export function menuIndexForKey(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

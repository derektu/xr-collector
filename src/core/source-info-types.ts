import type { DocumentSourceType } from './document-types.js';
import type { SubscriptionSettings } from './subscription-types.js';

/** What one kind of address of a source type can do: collect a single item or subscribe to new ones. */
export type SourceCapability = 'single' | 'subscription';

export interface SourceKindInfo {
  id: string;
  /** Shown as the kind of a source row and a confirmation card. */
  label: string;
  capability: SourceCapability;
  /** What one collected item is called, e.g. "影片". */
  itemNoun: string;
}

/** A collection setting chosen from a list of values. */
export interface ChoiceSettingField {
  input: 'choice';
  key: string;
  label: string;
  options: Array<{ value: string | number; label: string }>;
  /** The value a new subscription starts with. */
  default: string | number;
}

/** A collection setting typed as a whole number from `min` to `max`. */
export interface NumberSettingField {
  input: 'number';
  key: string;
  label: string;
  min: number;
  max: number;
  /** What the number counts, shown after the input, e.g. "天" or "支影片". */
  unit: string;
  /** The value a new subscription starts with. */
  default: number;
}

export type SourceSettingField = ChoiceSettingField | NumberSettingField;

/** The public part of a source type declaration; the UI builds entry, filters and icons from it. */
export interface SourceTypeInfo {
  id: DocumentSourceType;
  label: string;
  /** Key of the icon the UI draws for this type. */
  icon: string;
  kinds: SourceKindInfo[];
  /** Collecting needs a signed-in account; such addresses are recognized but not resolved. */
  requiresLogin: boolean;
  /** Collection settings a subscription of this type uses. */
  settings: SourceSettingField[];
}

export type RecognitionStatus = 'ready' | 'login_required' | 'unsupported' | 'unavailable';

/** One step the recognized address offers, with the request that performs it. */
export interface RecognitionAction {
  id: 'collect' | 'subscribe' | 'resume';
  label: string;
  primary: boolean;
  request: { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> };
}

/** What a pasted address is and what can be done with it. */
export interface UrlRecognition {
  status: RecognitionStatus;
  sourceType: DocumentSourceType | null;
  kind: string | null;
  kindLabel: string | null;
  /** The address the actions use; the input as given when nothing recognized it. */
  url: string;
  /** The item or subscription target; an item's title is null because recognition does not contact the source. */
  target: { id: string; title: string | null; url: string } | null;
  /** The existing subscription of a recognized subscription address, with its own settings. */
  subscription: { id: string; enabled: boolean; settings: SubscriptionSettings } | null;
  /** The settings a new subscription starts with: the source type's defaults. */
  settings: SubscriptionSettings | null;
  /** Whether automatic collection is on; null when the address is not a subscription. */
  autoCollection: boolean | null;
  actions: RecognitionAction[];
  login: { sourceType: DocumentSourceType; label: string; message: string } | null;
  /** Why the address cannot be used, for `unsupported` and `unavailable`. */
  message: string | null;
}

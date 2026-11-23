import type { DocumentSourceType } from '../documents/document-types.js';
import type { SubscriptionSettings } from '../subscriptions/subscription-types.js';

export type SourceCapability = 'single' | 'subscription';

export interface SourceKindInfo {
  id: string;
  label: string;
  capability: SourceCapability;
  itemNoun: string;
}

export interface ChoiceSettingField {
  input: 'choice';
  key: string;
  label: string;
  options: Array<{ value: string | number; label: string }>;
  default: string | number;
}

export interface NumberSettingField {
  input: 'number';
  key: string;
  label: string;
  min: number;
  max: number;
  unit: string;
  default: number;
}

export type SourceSettingField = ChoiceSettingField | NumberSettingField;

export interface SourceTypeInfo {
  id: DocumentSourceType;
  label: string;
  icon: string;
  kinds: SourceKindInfo[];
  requiresLogin: boolean;
  settings: SourceSettingField[];
}

export type RecognitionStatus = 'ready' | 'login_required' | 'unsupported' | 'unavailable';

export interface RecognitionAction {
  id: 'collect' | 'subscribe' | 'resume';
  label: string;
  primary: boolean;
  request: { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> };
}

export interface UrlRecognition {
  status: RecognitionStatus;
  sourceType: DocumentSourceType | null;
  kind: string | null;
  kindLabel: string | null;
  /** The address the actions use; the input as given when nothing recognized it. */
  url: string;
  target: { id: string; title: string | null; url: string } | null;
  subscription: { id: string; enabled: boolean; settings: SubscriptionSettings } | null;
  settings: SubscriptionSettings | null;
  /** Whether automatic collection is on; null when the address is not a subscription. */
  autoCollection: boolean | null;
  actions: RecognitionAction[];
  login: { sourceType: DocumentSourceType; label: string; message: string } | null;
  message: string | null;
}

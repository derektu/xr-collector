import { settingsErrors } from '../../shared/sources/collection-settings.js';
import type { RecognitionAction, SourceSettingField, UrlRecognition } from '../../shared/sources/source-info-types.js';
import type { SubscriptionSettings } from '../../shared/subscriptions/subscription-types.js';

export interface ChosenSettings {
  recognition: UrlRecognition;
  settings: SubscriptionSettings;
}

export function settingsFor(chosen: ChosenSettings | null, found: UrlRecognition): SubscriptionSettings | null {
  return chosen?.recognition === found ? chosen.settings : found.settings;
}

export function subscribeWaitsForSettings(action: Pick<RecognitionAction, 'id'> | null, fields: readonly SourceSettingField[], settings: SubscriptionSettings | null): boolean {
  return action?.id === 'subscribe' && settings !== null && settingsErrors(fields, settings).length > 0;
}

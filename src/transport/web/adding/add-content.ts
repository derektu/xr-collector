import { settingsErrors } from '../../../shared/sources/collection-settings.js';
import type { DocumentStatus } from '../../../shared/documents/document-types.js';
import type { RecognitionAction, SourceSettingField, UrlRecognition } from '../../../shared/sources/source-info-types.js';
import type { SubscriptionSettings } from '../../../shared/subscriptions/subscription-types.js';

export interface ChosenSettings {
  recognition: UrlRecognition;
  settings: SubscriptionSettings;
}

export type StatusChoice = 'subscribe' | 'collect';

const lastStatus: Record<StatusChoice, DocumentStatus> = { subscribe: 'published', collect: 'published' };

export function lastDocumentStatus(choice: StatusChoice): DocumentStatus {
  return lastStatus[choice];
}

export function rememberDocumentStatus(choice: StatusChoice, status: DocumentStatus): void {
  lastStatus[choice] = status;
}

export function settingsFor(chosen: ChosenSettings | null, found: UrlRecognition): SubscriptionSettings | null {
  if (chosen?.recognition === found) return chosen.settings;
  if (!found.settings || found.subscription) return found.settings;
  return { ...found.settings, documentStatus: lastStatus.subscribe };
}

export function subscribeWaitsForSettings(action: Pick<RecognitionAction, 'id'> | null, fields: readonly SourceSettingField[], settings: SubscriptionSettings | null): boolean {
  return action?.id === 'subscribe' && settings !== null && settingsErrors(fields, settings).length > 0;
}

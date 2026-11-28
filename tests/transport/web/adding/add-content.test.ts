// Broken, settings chosen for an earlier recognition of an address carry over, the add dialog subscribes with a setting its field rejects, or
// the status last chosen in the dialog overwrites an existing subscription's own.
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceSettingField, UrlRecognition } from '../../../../src/shared/sources/source-info-types.js';
import { rememberDocumentStatus, settingsFor, subscribeWaitsForSettings } from '../../../../src/transport/web/adding/add-content.js';

function recognition(): UrlRecognition {
  return {
    status: 'ready', sourceType: 'youtube', kind: 'channel', kindLabel: 'YouTube 頻道', url: 'https://www.youtube.com/@a', target: null,
    subscription: null, settings: { intervalMinutes: 60, backfillDays: 7, documentStatus: 'published' }, autoCollection: null, actions: [], login: null, message: null,
  };
}

const fields: SourceSettingField[] = [
  { input: 'number', key: 'backfillDays', label: '天數', min: 1, max: 60, unit: '天', default: 7 },
];

describe('add dialog settings', () => {
  it('settings chosen for one recognition do not carry over to a new recognition of the address', () => {
    const first = recognition();
    const chosen = { recognition: first, settings: { intervalMinutes: 15, backfillDays: 30, documentStatus: 'published' as const } };
    expect(settingsFor(chosen, first)).toBe(chosen.settings);
    const again = recognition();
    expect(settingsFor(chosen, again)).toEqual(again.settings);
  });

  afterEach(() => rememberDocumentStatus('subscribe', 'published'));

  it('a new subscription starts with the status last subscribed with; an existing subscription keeps its own', () => {
    rememberDocumentStatus('subscribe', 'draft');
    expect(settingsFor(null, recognition())?.documentStatus).toBe('draft');
    const existing = { ...recognition(), subscription: { id: 'a', enabled: false, settings: recognition().settings! } };
    expect(settingsFor(null, existing)?.documentStatus).toBe('published');
  });

  it('a new subscription waits while a setting holds a value its field rejects; collecting and resuming never wait', () => {
    const rejected = { intervalMinutes: 60, backfillDays: 0, documentStatus: 'published' as const };
    expect(subscribeWaitsForSettings({ id: 'subscribe' }, fields, rejected)).toBe(true);
    expect(subscribeWaitsForSettings({ id: 'subscribe' }, fields, { intervalMinutes: 60, backfillDays: 7, documentStatus: 'published' })).toBe(false);
    expect(subscribeWaitsForSettings({ id: 'collect' }, fields, rejected)).toBe(false);
    expect(subscribeWaitsForSettings({ id: 'resume' }, fields, rejected)).toBe(false);
    expect(subscribeWaitsForSettings(null, fields, rejected)).toBe(false);
  });
});

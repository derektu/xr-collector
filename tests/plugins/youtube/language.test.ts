import { describe, expect, it } from 'vitest';
import { chooseSubtitleTrack, type SubtitleTrack } from '../../../src/plugins/youtube/language.js';

const track = (
  code: string,
  kind: SubtitleTrack['kind'],
  isOriginal = true,
): SubtitleTrack => ({ code, kind, name: null, isOriginal });

describe('chooseSubtitleTrack', () => {
  it('prefers the requested language before subtitle kind', () => {
    expect(
      chooseSubtitleTrack([
        track('en', 'manual'),
        track('zh-Hant', 'automatic', true),
      ]),
    ).toEqual(track('zh-Hant', 'automatic'));
  });

  it('prefers manual captions within the same language', () => {
    expect(
      chooseSubtitleTrack([
        track('zh-TW', 'automatic'),
        track('zh-TW', 'manual'),
      ]),
    ).toEqual(track('zh-TW', 'manual'));
  });

  it('never treats live chat as a subtitle track', () => {
    expect(chooseSubtitleTrack([track('live_chat', 'manual')])).toBeNull();
  });

  it('does not select auto-translated tracks', () => {
    expect(
      chooseSubtitleTrack([
        track('zh-Hant', 'automatic', false),
        track('en-orig', 'automatic', true),
      ]),
    ).toEqual(track('en-orig', 'automatic', true));
  });

  it('prefers the -orig automatic track over another original automatic track of the language', () => {
    expect(chooseSubtitleTrack([track('en', 'automatic', true), track('en-orig', 'automatic', true)]))
      .toEqual(track('en-orig', 'automatic', true));
    expect(chooseSubtitleTrack([track('ja', 'automatic', true), track('ja-orig', 'automatic', true)]))
      .toEqual(track('ja-orig', 'automatic', true));
  });
});

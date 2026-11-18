import type { SubtitleKind } from './adapter.js';

export interface SubtitleTrack {
  code: string;
  name: string | null;
  kind: SubtitleKind;
  isOriginal: boolean;
}

const LANGUAGE_PRIORITY = [
  'zh-TW',
  'zh-Hant',
  'zh-HK',
  'zh',
  'zh-Hans',
  'zh-CN',
  'en-orig',
  'en',
];

function normalized(code: string): string {
  return code.toLowerCase();
}

function isUsable(track: SubtitleTrack): boolean {
  return track.code !== 'live_chat' && !track.code.startsWith('comments');
}

function isOrigTrack(track: SubtitleTrack): boolean {
  return track.kind === 'automatic' && /-orig$/i.test(track.code);
}

/** Original automatic captions, the `-orig` track before any other one. */
function originalAutomatic(tracks: SubtitleTrack[]): SubtitleTrack | undefined {
  return tracks.find((track) => isOrigTrack(track) && track.isOriginal)
    ?? tracks.find((track) => track.kind === 'automatic' && track.isOriginal);
}

/**
 * Picks the subtitle track to download. Languages follow `LANGUAGE_PRIORITY`; within a language a
 * manual track comes first, then the `<lang>-orig` automatic track, then any other automatic track
 * in the spoken language. Automatic tracks translated from another language are never chosen.
 */
export function chooseSubtitleTrack(tracks: SubtitleTrack[]): SubtitleTrack | null {
  const usable = tracks.filter(isUsable);

  for (const preferred of LANGUAGE_PRIORITY) {
    const sameLanguage = usable.filter((track) => {
      const code = track.code.replace(/-orig$/i, '');
      const target = preferred.replace(/-orig$/i, '');
      return normalized(code) === normalized(target);
    });
    const manual = sameLanguage.find((track) => track.kind === 'manual');
    if (manual) return manual;
    const automatic = originalAutomatic(sameLanguage);
    if (automatic) return automatic;
  }

  return usable.find((track) => track.kind === 'manual') ?? originalAutomatic(usable) ?? null;
}

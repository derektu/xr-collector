import type { SubtitleKind } from './types.js';

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
    const automatic = sameLanguage.find(
      (track) => track.kind === 'automatic' && track.isOriginal,
    );
    if (automatic) return automatic;
  }

  return (
    usable.find((track) => track.kind === 'manual') ??
    usable.find((track) => track.kind === 'automatic' && track.isOriginal) ??
    null
  );
}

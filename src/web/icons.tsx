import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  sources: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>,
  documents: <><path d="M6 3h9l5 5v13H6z" /><path d="M14 3v6h6" /></>,
  activity: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  jobs: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  failed: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>,
  skipped: <><circle cx="12" cy="12" r="9" /><path d="M7 12h10" /></>,
  check: <path d="M5 12l5 5 9-10" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-4.5L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14 4.5l2-1.5" /><path d="M20 21v-5h-5" /></>,
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M8 5l11 7-11 7z" />,
  back: <path d="M15 18l-6-6 6-6" />,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  file: <><path d="M6 3h9l5 5v13H6z" /><path d="M14 3v6h6" /><path d="M9 14h6M9 17h4" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
};

/** Adds icons by name, such as the icon each source type is drawn with; the web assembly registers them. */
export function registerIcons(icons: Record<string, ReactNode>): void {
  Object.assign(PATHS, icons);
}

/** Line icons drawn with the current text color; they are decorative unless a label is given. */
export function Icon({ name, size = 16, label }: { name: string; size?: number; label?: string }) {
  if (name === 'more') {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}>
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>;
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}>
    {PATHS[name] ?? PATHS.file}
  </svg>;
}

/** The square badge a source type is drawn with in lists and cards; its size comes from the surrounding CSS. */
export function SourceTypeBadge({ icon }: { icon: string }) {
  return <span className={`type-badge type-${icon}`} aria-hidden="true"><Icon name={icon} size={17} /></span>;
}

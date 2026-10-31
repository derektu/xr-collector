import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The window and the tray learn about changes from the server's change stream, never by reading
// again on a timer. Timers remain for what waits on the person (typing pauses, hover, how long a
// notice stays), for spacing reads after changes, and for drawing day-relative labels at midnight.

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

const sources = [...filesUnder('src/web').filter((file) => /\.tsx?$/u.test(file)), 'src/electron/tray.ts'];
const using = (pattern: RegExp) => sources.filter((file) => pattern.test(readFileSync(file, 'utf8'))).sort();

describe('screens without polling', () => {
  it('uses no interval timers in the window or the tray', () => {
    expect(sources).toContain('src/web/App.tsx');
    expect(using(/setInterval\(/u)).toEqual([]);
  });

  it('keeps timeouts to typing pauses, hover, notices, read spacing and midnight', () => {
    expect(using(/setTimeout\(/u)).toEqual([
      'src/electron/tray.ts', // spaces reads after changes; draws again at midnight
      'src/web/AddContent.tsx', // recognizes an address after a pause in typing
      'src/web/AgentConnectionHelp.tsx', // closes the hover help after the pointer leaves
      'src/web/App.tsx', // hides a notice
      'src/web/Documents.tsx', // searches after a pause in typing
      'src/web/SourceDetail.tsx', // saves a typed setting after a pause in typing
      'src/web/VaultLocation.tsx', // checks a typed location after a pause in typing
      'src/web/dev/OnboardingPreview.tsx', // simulates a slow inspection in the design preview
      'src/web/use-changes.ts', // spaces reads after changes; opens the change stream again after the server refused it
      'src/web/use-day.ts', // draws day-relative labels again at midnight
    ]);
  });
});

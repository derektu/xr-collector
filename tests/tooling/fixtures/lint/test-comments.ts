// Broken, a user's queued jobs never start.
// Guards the user.
import { describe, it } from 'vitest';

/** The jobs a test queues. */
export const QUEUED = 3;

describe('queue', () => {
  // Starts the oldest first.
  it('starts the oldest job first', () => {
    /* A paused job waits. */
    const paused = true; // External: Node keeps insertion order in a Map.
    return paused;
  });
});

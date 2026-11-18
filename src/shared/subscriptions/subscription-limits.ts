/**
 * A subscription pauses itself once this many checks in a row failed and the first of them ended
 * at least AUTO_PAUSE_AFTER_MS earlier, so neither a burst of failures nor a long but rare outage
 * pauses it.
 */
export const AUTO_PAUSE_FAILURES = 5;

export const AUTO_PAUSE_AFTER_MS = 24 * 60 * 60_000;

/** Checks that may each try a failed item of a subscription before it is skipped. */
export const MAX_CHECK_ATTEMPTS = 3;

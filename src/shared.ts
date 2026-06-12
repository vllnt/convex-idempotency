/** Shared constants used by both `client/` and `component/`. */

export const COMPONENT_NAME = "idempotency";

/** Default namespace when the host does not scope a key. */
export const DEFAULT_SCOPE = "global";

/**
 * Default inflight lease: 60 seconds, in milliseconds. Short by design so a
 * crashed worker's claim self-heals quickly and the key can be re-minted.
 */
export const DEFAULT_INFLIGHT_TTL_MS = 60_000;

/**
 * Default done grace window: 24 hours, in milliseconds. How long a recorded
 * outcome replays before the key may be re-minted.
 */
export const DEFAULT_DONE_TTL_MS = 86_400_000;

/** Default page size for a `purge` pass before the sweep self-reschedules. */
export const DEFAULT_PURGE_BATCH = 200;

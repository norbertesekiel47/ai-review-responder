// src/lib/notifications/channels/constants.ts
//
// Shared constants for channel enrollment flows. Used by both the React hook
// (use-enrollment.ts) and the route handlers (telegram start/cancel/disable).
// Keeping these co-located prevents the polling interval and TTL from drifting
// out of sync between client and server.

/** Verification token TTL — 1 hour. Matches the existing admin telegram start route. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Polling interval for the status endpoint while in `awaiting_scan` state. */
export const STATUS_POLL_INTERVAL_MS = 3_000;

/** TTL countdown tick interval (drives `awaiting_scan` → `expired` transition). */
export const TTL_TICK_INTERVAL_MS = 1_000;

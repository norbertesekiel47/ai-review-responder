// src/lib/config/flags.ts
//
// Runtime-agnostic feature-flag primitive — a PEER of getServerConfig/getWorkerConfig,
// deliberately NOT routed through them. A flag's value is the same literal string on
// Vercel and Railway, so a worker-owned flag (CHANNELS_TELEGRAM_ENABLED,
// ZERNIO_PUBLISHING_ENABLED, RANKING_TRACKING_ENABLED, AUTO_APPROVAL_ENABLED, …) must
// not be forced through Next-server config assumptions; readFlag reads a plain
// process.env snapshot identically in both runtimes.
//
// This is the single sanctioned env reader for *_ENABLED / *_DISABLED boolean flags
// (allowlisted via the src/lib/config/ prefix in process-env-baseline.ts). Per-feature
// <feature>/flags.ts accessors call readFlag; Stage-4's ci:static-policy guard bans
// inline `process.env.*_ENABLED` everywhere else (invariant #13 — flags stay
// server-authoritative, never NEXT_PUBLIC).
//
// NOT memoized: a flag read is a single cheap process.env property compare, and not
// memoizing keeps tests free of the reset-the-memo dance (and lets an integration
// test toggle a flag mid-run, matching the old direct `process.env.X === 'true'`).

/** True iff the named boolean env flag is set to the literal string 'true'. */
export function readFlag(name: string): boolean {
  return process.env[name] === 'true';
}

// Use VERCEL_TARGET_ENV, not VERCEL_ENV: a preview-type custom environment such as
// `staging` reports VERCEL_ENV='preview' but VERCEL_TARGET_ENV='staging'. Only genuine
// per-PR previews have VERCEL_TARGET_ENV='preview'. Both are runtime-available. This is
// the one home for the target-env resolution (moved here from auto-approval/flags.ts).
export function isPreviewEnvironment(): boolean {
  return process.env.VERCEL_TARGET_ENV === 'preview';
}

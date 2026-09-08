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

/** True UNLESS the named boolean env flag is set to the literal string 'false'.
 *  The DEFAULT-ON inverse of readFlag — for the rare default-on kill switch
 *  (e.g. LLM_CIRCUIT_BREAKER_ENABLED). Same single-sanctioned-reader home. */
export function readFlagEnabledByDefault(name: string): boolean {
  return process.env[name] !== 'false';
}

// Use VERCEL_TARGET_ENV, not VERCEL_ENV: a preview-type custom environment such as
// `staging` reports VERCEL_ENV='preview' but VERCEL_TARGET_ENV='staging'. Only genuine
// per-PR previews have VERCEL_TARGET_ENV='preview'. Both are runtime-available. This is
// the one home for the target-env resolution (moved here from auto-approval/flags.ts).
export function isPreviewEnvironment(): boolean {
  return process.env.VERCEL_TARGET_ENV === 'preview';
}

/**
 * Must this process be TREATED as the production deployment target?
 *
 * Sibling of `isPreviewEnvironment`, same variable — but deliberately NOT a
 * plain `=== 'production'`. It FAILS CLOSED on a MISSING signal, and that
 * asymmetry is the point. Its one caller is the Admin origin allowlist's
 * loopback rule (#1186), which ADR 0026 D2 requires to be inert in production.
 * A plain equality check makes the ABSENCE of evidence read as evidence of
 * non-production — and a Vercel project whose system environment variables are
 * not exposed has exactly that absence on a real production deployment, which
 * would admit `http://localhost:<any port>` there. Adversarial review A1 found it.
 *
 * A non-empty `VERCEL_TARGET_ENV` is affirmative evidence and is trusted
 * verbatim: `production` is production, and any other value (`preview`,
 * `staging`, a future custom-environment name) is a target Vercel does not call
 * production. An empty or missing value means either "on Vercel with the signal
 * switched off" — treat as production — or "not a Vercel deployment at all"
 * (local dev, a test run, the Railway worker), where `VERCEL` is unset and
 * loopback is the whole point.
 *
 * `requiresProductionConfig()` (src/lib/config/deployment-lane.ts) is NOT a
 * substitute and must not be swapped in: it is the UNION of the lane signals,
 * and Vercel sets `NODE_ENV=production` on staging AND preview builds too, so
 * it would make the loopback rule inert on staging — the one environment
 * ADR 0024 D7 built it for. The two ask different questions: that one asks
 * "must this process satisfy production-grade config?" (broad on purpose),
 * this one asks "is this the production deployment TARGET?".
 */
export function isProductionEnvironment(): boolean {
  const target = process.env.VERCEL_TARGET_ENV?.trim();
  if (target) return target === 'production';
  return process.env.VERCEL !== undefined;
}

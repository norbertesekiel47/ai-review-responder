// src/lib/config/deployment-lane.ts
//
// The authoritative answer to "which deployment lane is this process in?".
//
// `NODE_ENV` cannot answer it. Verified live against Railway on 2026-07-28:
// staging sets NODE_ENV=production and RAILWAY_ENVIRONMENT_NAME=staging, while
// production leaves NODE_ENV UNSET and sets RAILWAY_ENVIRONMENT_NAME=production.
// So asking NODE_ENV gets "production" on staging (#610 — Sentry mis-tags every
// event and cron check-in) and `undefined` in production (#611 — production-only
// boot gates return early and are inert).
//
// The two exported predicates read the same variables but are deliberately NOT
// the same rule, and must not be collapsed:
//
//   * `deploymentLane` resolves the lane NAME by PRECEDENCE. Railway wins
//     whenever present. A `RAILWAY_ENVIRONMENT_NAME || NODE_ENV`-style union
//     would classify staging as production — staging sets BOTH signals — which
//     is exactly the #610 defect.
//   * `requiresProductionConfig` is the UNION. It answers "must this process
//     satisfy production-grade config?", not "where am I", and being broad is
//     the point: every environment that enforces today keeps enforcing, and
//     the production Railway lane is added.
//
// There is deliberately no `isProductionLane()`. A lane-name equality check has
// no caller today, and an abstraction with zero callers is a liability.
//
// Lives in src/lib/config/ rather than worker/ because src/lib/config/worker.ts
// and src/lib/shared/logger.ts are call sites, and the dependency direction is
// one-way (worker/ imports src/lib/, never the reverse — invariant #1). It is
// its own file rather than part of flags.ts, which owns boolean *_ENABLED
// feature flags; a deployment lane is not a feature flag.

/**
 * Just the two variables this module reads. Narrower than `NodeJS.ProcessEnv`
 * on purpose: `platformLaneEnv()` pulls each one by NAME so the Railway read is
 * a `process.env.RAILWAY_*` access, which `ci:process-env` exempts as a platform
 * indicator. Taking the whole `process.env` object as a default parameter would
 * instead read as an un-named whole-object alias.
 */
export interface DeploymentLaneEnv {
  RAILWAY_ENVIRONMENT_NAME?: string | undefined;
  NODE_ENV?: string | undefined;
}

function platformLaneEnv(): DeploymentLaneEnv {
  return {
    RAILWAY_ENVIRONMENT_NAME: process.env.RAILWAY_ENVIRONMENT_NAME,
    NODE_ENV: process.env.NODE_ENV,
  };
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Which variable the lane was read from. Undefined when neither was set. */
type LaneSource = 'RAILWAY_ENVIRONMENT_NAME' | 'NODE_ENV';

/**
 * The one place the precedence rule is stated. Both `deploymentLane` and
 * `deploymentLaneFields` derive from it, so a lane and the `lane_source` that
 * explains it cannot disagree — and adding a third signal is a single edit.
 * Internal by design: the public surface stays at exactly three exports.
 */
function resolveLane(env: DeploymentLaneEnv): { lane: string; source?: LaneSource } {
  const railway = trimmedOrUndefined(env.RAILWAY_ENVIRONMENT_NAME);
  if (railway) return { lane: railway, source: 'RAILWAY_ENVIRONMENT_NAME' };
  const nodeEnv = trimmedOrUndefined(env.NODE_ENV);
  if (nodeEnv) return { lane: nodeEnv, source: 'NODE_ENV' };
  return { lane: 'development' };
}

/**
 * The lane name to report to humans and to Sentry: the Railway environment name
 * when set, else NODE_ENV, else 'development'. Unrecognised Railway environment
 * names pass through unchanged — this is a report of where the process runs, not
 * a validated enum.
 */
export function deploymentLane(env: DeploymentLaneEnv = platformLaneEnv()): string {
  return resolveLane(env).lane;
}

/**
 * True when this process must satisfy production-grade configuration — on ANY
 * deployed Railway lane, or in any NODE_ENV=production run. The union of the
 * two signals, never their precedence: narrowing it would silently disable a
 * gate that fires today. Deliberately NOT routed through `resolveLane` — it is
 * a second, independent rule that happens to read the same two variables.
 */
export function requiresProductionConfig(
  env: DeploymentLaneEnv = platformLaneEnv(),
): boolean {
  return (
    trimmedOrUndefined(env.RAILWAY_ENVIRONMENT_NAME) !== undefined ||
    trimmedOrUndefined(env.NODE_ENV) === 'production'
  );
}

/**
 * Log/tag fields for the resolved lane. `lane_source` names the variable the
 * lane was actually read from, so a surprising lane can be traced to its cause;
 * it is omitted when neither variable is set, because 'development' is then a
 * default rather than a reading.
 */
export function deploymentLaneFields(
  env: DeploymentLaneEnv = platformLaneEnv(),
): Record<string, string> {
  const { lane, source } = resolveLane(env);
  const fields: Record<string, string> = { deployment_lane: lane };
  if (source) fields.lane_source = source;
  return fields;
}

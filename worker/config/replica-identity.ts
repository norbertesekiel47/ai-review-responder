// Replica identity for the single-replica invariant (#567, arch review R1).
//
// Four mechanisms are correct ONLY while the worker runs as a single replica:
// `assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, the overage
// idempotency guard (OVERAGE-F1), and the in-process LLM circuit breaker. The
// backlog's P2 section lists the pollers that become duplicate-processing bugs
// the moment a second replica exists
// (docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md).
//
// Nothing can enforce that invariant from inside one process: Railway injects a
// per-replica `RAILWAY_REPLICA_ID` but NO replica count, so a booting worker
// cannot tell whether it is the only one. What it CAN do is announce which
// replica it is, on every boot, in a form that makes a second one obvious —
// scaling up starts a new replica (Railway does not redeploy the existing one),
// so a second identity appearing in the logs or on a Sentry event IS the signal.
//
// `ci:static-policy` covers the config-as-code half: railway.toml may not
// declare replicas. Replicas set in the dashboard can only be caught here.

/** Railway system variables (docs.railway.com/variables/reference). */
export interface ReplicaIdentity {
  replicaId: string | undefined;
  deploymentId: string | undefined;
  region: string | undefined;
  serviceName: string | undefined;
  environmentName: string | undefined;
  /** False for local/dev runs, where none of the Railway variables are set. */
  onRailway: boolean;
}

/**
 * Just the Railway system variables this module reads. Narrower than
 * `NodeJS.ProcessEnv` on purpose: `platformReplicaEnv()` pulls each one by NAME
 * so every read is a `process.env.RAILWAY_*` access, which `ci:process-env`
 * exempts as a platform indicator. Taking the whole `process.env` object as a
 * default parameter would instead read as an un-named whole-object alias and
 * would need an allowlist carve-out.
 */
export interface ReplicaEnv {
  RAILWAY_REPLICA_ID?: string | undefined;
  RAILWAY_DEPLOYMENT_ID?: string | undefined;
  RAILWAY_REPLICA_REGION?: string | undefined;
  RAILWAY_SERVICE_NAME?: string | undefined;
  RAILWAY_ENVIRONMENT_NAME?: string | undefined;
}

function platformReplicaEnv(): ReplicaEnv {
  return {
    RAILWAY_REPLICA_ID: process.env.RAILWAY_REPLICA_ID,
    RAILWAY_DEPLOYMENT_ID: process.env.RAILWAY_DEPLOYMENT_ID,
    RAILWAY_REPLICA_REGION: process.env.RAILWAY_REPLICA_REGION,
    RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
    RAILWAY_ENVIRONMENT_NAME: process.env.RAILWAY_ENVIRONMENT_NAME,
  };
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readReplicaIdentity(
  env: ReplicaEnv = platformReplicaEnv(),
): ReplicaIdentity {
  const replicaId = trimmedOrUndefined(env.RAILWAY_REPLICA_ID);
  const deploymentId = trimmedOrUndefined(env.RAILWAY_DEPLOYMENT_ID);
  return {
    replicaId,
    deploymentId,
    region: trimmedOrUndefined(env.RAILWAY_REPLICA_REGION),
    serviceName: trimmedOrUndefined(env.RAILWAY_SERVICE_NAME),
    environmentName: trimmedOrUndefined(env.RAILWAY_ENVIRONMENT_NAME),
    onRailway: replicaId !== undefined || deploymentId !== undefined,
  };
}

/**
 * Log/tag fields for an identity. Only defined values are included, so a local
 * run emits `{}` rather than a row of nulls.
 */
export function replicaIdentityFields(
  identity: ReplicaIdentity,
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (identity.replicaId) fields.replica_id = identity.replicaId;
  if (identity.deploymentId) fields.deployment_id = identity.deploymentId;
  if (identity.region) fields.replica_region = identity.region;
  if (identity.serviceName) fields.service_name = identity.serviceName;
  if (identity.environmentName) fields.railway_environment = identity.environmentName;
  return fields;
}

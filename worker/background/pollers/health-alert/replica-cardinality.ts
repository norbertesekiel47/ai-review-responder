// Replica-cardinality alerting for the single-replica invariant (#587,
// follow-up to #567).
//
// #567 made the worker ANNOUNCE which replica it is (worker/config/replica-identity.ts)
// and blocked replica declarations in railway.toml. Neither acts on the signal:
// Sentry tags only decorate later events and the boot line is an ordinary log,
// so a dashboard- or CLI-initiated scale-out leaves a second replica quietly
// processing jobs and pollers until somebody happens to read logs.
//
// This registers each live replica in Redis under a TTL and pages when more than
// one is alive. Deliberately NOT a boot-gating lease: Upstash already carries
// cache, rate-limit, cost-reserve, regen-budget and idempotent-generation as a
// single point of failure, and putting worker startup behind it would trade a
// latent "two replicas duplicate work" risk for an active "zero replicas run"
// outage. Detection stays the posture (CLAUDE.md); this closes the gap that
// nothing acted on it. When the P2 items in
// docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md clear and
// multiple replicas become legitimate, this becomes a threshold to raise rather
// than architecture to remove.
import type { Redis } from 'ioredis';
import type { ReplicaIdentity } from '../../../config/replica-identity';
import type { HealthFinding } from './checks';

const KEY_PREFIX = 'repworth:replica';

/**
 * TTL as a multiple of the poll interval. Must exceed 1 so a single late or
 * skipped cycle does not deregister a LIVE replica (a false negative — the
 * invariant would go unpoliced).
 */
const TTL_INTERVAL_MULTIPLE = 2;

/**
 * Cycles a cross-deployment overlap must persist before it pages.
 *
 * Bound by TTL, not by taste. A replica that dies leaves its key behind for up
 * to `TTL_INTERVAL_MULTIPLE` intervals; the new replica starts counting at boot
 * and its first cycle runs immediately, so it reaches cycle N at
 * `(N - 1) × interval`. Paging before the dead replica's key expires would
 * false-page on every clean deploy, which is what the first cut of this did.
 * Hence the invariant, asserted in the unit tests:
 *
 *     DEPLOY_OVERLAP_GRACE_CYCLES > TTL_INTERVAL_MULTIPLE + 1
 *
 * At the 5-minute default that is: stale key gone by t≤600s, alert at t=900s.
 * There is deliberately no deregistration-on-shutdown path — it would be a
 * Redis call on the shutdown critical path that a SIGKILL or OOM skips anyway,
 * so the timing above has to be correct with or without it.
 */
const DEPLOY_OVERLAP_GRACE_CYCLES = 4;

/**
 * Iteration cap on the registry SCAN. Redis applies MATCH *after* scanning, so
 * on a shared Upstash instance (cache + rate-limit + cost-reserve + …) a full
 * walk is not free. A handful of replica keys needs a handful of iterations;
 * anything beyond this is a pathological keyspace, and stopping early degrades
 * to "counted fewer replicas" rather than hanging the health probe.
 */
const SCAN_MAX_ITERATIONS = 20;

/** Exported for the invariant test only — see DEPLOY_OVERLAP_GRACE_CYCLES. */
export const REPLICA_TIMING = {
  ttlIntervalMultiple: TTL_INTERVAL_MULTIPLE,
  deployOverlapGraceCycles: DEPLOY_OVERLAP_GRACE_CYCLES,
} as const;

/** One replica seen alive in the registry within its TTL. */
export interface LiveReplica {
  replicaId: string;
  deploymentId: string | undefined;
}

/** Registry scope — replicas of different services/environments never mix. */
function replicaKeyPrefix(identity: ReplicaIdentity): string {
  const service = identity.serviceName ?? 'worker';
  const environment = identity.environmentName ?? 'unknown';
  return `${KEY_PREFIX}:${service}:${environment}`;
}

/**
 * Refresh this replica's registration. A replica that dies disappears when its
 * TTL lapses — there is no deregistration path to get wrong.
 */
async function heartbeatReplica(
  redis: Redis,
  identity: ReplicaIdentity,
  ttlSeconds: number,
): Promise<void> {
  const key = `${replicaKeyPrefix(identity)}:${identity.replicaId}`;
  await redis.set(key, identity.deploymentId ?? '', 'EX', ttlSeconds);
}

/** Every replica currently registered for this identity's scope. */
async function readLiveReplicas(
  redis: Redis,
  identity: ReplicaIdentity,
): Promise<LiveReplica[]> {
  const prefix = replicaKeyPrefix(identity);
  const keys: string[] = [];
  let cursor = '0';
  let iterations = 0;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
    iterations += 1;
  } while (cursor !== '0' && iterations < SCAN_MAX_ITERATIONS);

  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  return keys
    .map((key, index) => ({
      replicaId: key.slice(prefix.length + 1),
      deploymentId: values[index] ? values[index]! : undefined,
      raw: values[index],
    }))
    // A key that expired between SCAN and MGET returns null — no longer live.
    .filter((entry) => entry.raw !== null)
    .map(({ replicaId, deploymentId }) => ({ replicaId, deploymentId }))
    .sort((left, right) => left.replicaId.localeCompare(right.replicaId));
}

/** True when two or more replicas report the SAME deployment id. */
function hasSharedDeployment(replicas: LiveReplica[]): boolean {
  const seen = new Set<string>();
  for (const { deploymentId } of replicas) {
    const key = deploymentId ?? '';
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Cross-deployment overlap is normal and transient during a zero-downtime
 * deploy, so it is counted rather than alerted on immediately. Any other shape —
 * including a shared-deployment scale-out, which alerts on its own terms —
 * resets the counter.
 */
export function nextCrossDeploymentCycles(
  replicas: LiveReplica[],
  current: number,
): number {
  if (replicas.length < 2 || hasSharedDeployment(replicas)) return 0;
  return current + 1;
}

let observedOverlapCycles = 0;

/** Test seam — the counter is module state so the poller stays stateless. */
export function resetReplicaCardinalityState(): void {
  observedOverlapCycles = 0;
}

/**
 * One cycle: refresh this replica's registration, read the live set, decide.
 *
 * Takes the poll interval rather than a TTL so the module owns its own timing
 * policy — the TTL and the grace window are load-bearing on each other (see
 * DEPLOY_OVERLAP_GRACE_CYCLES) and must not be settable independently.
 *
 * Returns null off-platform (no Railway identity → no invariant to police). The
 * CALLER owns both the timeout and the failure swallow: a Redis outage must
 * degrade to "no replica alerting", never to a failed health cycle — that
 * fail-safe property is the reason this is a registry and not a lease.
 */
export async function checkReplicaCardinality(
  redis: Redis,
  identity: ReplicaIdentity,
  pollIntervalMs: number,
): Promise<HealthFinding | null> {
  if (!identity.onRailway || !identity.replicaId) return null;
  const ttlSeconds = Math.ceil((pollIntervalMs / 1000) * TTL_INTERVAL_MULTIPLE);
  await heartbeatReplica(redis, identity, ttlSeconds);
  const replicas = await readLiveReplicas(redis, identity);
  observedOverlapCycles = nextCrossDeploymentCycles(replicas, observedOverlapCycles);
  return evaluateReplicaCardinality(replicas, observedOverlapCycles);
}

function replicaFinding(
  replicas: LiveReplica[],
  reason: 'scale_out' | 'deploy_overlap_stuck',
  title: string,
  remediation: string,
  extra: Record<string, unknown> = {},
): HealthFinding {
  return {
    key: 'replica_cardinality',
    level: 'error',
    title,
    detail: {
      reason,
      replica_count: replicas.length,
      replica_ids: replicas.map(({ replicaId }) => replicaId),
      deployment_ids: [...new Set(replicas.map(({ deploymentId }) => deploymentId ?? '(none)'))],
      remediation,
      ...extra,
    },
  };
}

/**
 * Decides whether the live set warrants paging. Pure — the caller owns the Redis
 * read and the cycle counter.
 *
 * Two conditions, deliberately separated because they need different urgency:
 *  - **scale_out** — replicas sharing a deployment id. Railway starts a new
 *    replica without redeploying the existing one, so this is the documented
 *    dashboard/CLI scale-out signal. It will not resolve itself: page now.
 *  - **deploy_overlap_stuck** — replicas on different deployment ids, still
 *    overlapping after the grace window. Every release produces this shape
 *    briefly; one that outlives the window is a deploy that has not drained.
 */
export function evaluateReplicaCardinality(
  replicas: LiveReplica[],
  overlapCycles: number,
  graceCycles: number = DEPLOY_OVERLAP_GRACE_CYCLES,
): HealthFinding | null {
  if (replicas.length < 2) return null;

  if (hasSharedDeployment(replicas)) {
    return replicaFinding(
      replicas,
      'scale_out',
      `${replicas.length} worker replicas are live under one deployment`,
      'Scale the Railway worker service back to 1. Four boot guards and the '
        + 'in-process LLM circuit breaker assume a single replica, and the P2 '
        + 'pollers duplicate-process with two.',
    );
  }

  if (overlapCycles < graceCycles) return null;

  return replicaFinding(
    replicas,
    'deploy_overlap_stuck',
    `${replicas.length} worker replicas still overlapping across deployments`,
    'A zero-downtime deploy has not drained. Confirm the old deployment is '
      + 'terminating; both replicas are consuming jobs until it does.',
    { consecutive_cycles: overlapCycles },
  );
}

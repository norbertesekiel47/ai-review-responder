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

/** One replica seen alive in the registry within its TTL. */
export interface LiveReplica {
  replicaId: string;
  deploymentId: string | undefined;
}

/** Registry scope — replicas of different services/environments never mix. Module-private: `checkReplicaCardinality` is the only entry point. */
function replicaKeyPrefix(identity: ReplicaIdentity): string {
  const service = identity.serviceName ?? 'worker';
  const environment = identity.environmentName ?? 'unknown';
  return `${KEY_PREFIX}:${service}:${environment}`;
}

/**
 * Refresh this replica's registration. Called once per poller cycle with a TTL
 * comfortably longer than the interval, so a replica that dies disappears on its
 * own without any deregistration path to get wrong.
 *
 * A local run (no Railway variables) registers nothing — there is no invariant
 * to police off-platform.
 */
async function heartbeatReplica(
  redis: Redis,
  identity: ReplicaIdentity,
  ttlSeconds: number,
): Promise<void> {
  if (!identity.onRailway || !identity.replicaId) return;
  const key = `${replicaKeyPrefix(identity)}:${identity.replicaId}`;
  await redis.set(key, identity.deploymentId ?? '', 'EX', ttlSeconds);
}

/**
 * Every replica currently registered for this identity's scope. SCAN rather than
 * KEYS so the read never blocks the shared cache instance.
 */
async function readLiveReplicas(
  redis: Redis,
  identity: ReplicaIdentity,
): Promise<LiveReplica[]> {
  const prefix = replicaKeyPrefix(identity);
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  return keys
    .map((key, index) => ({
      replicaId: key.slice(prefix.length + 1),
      deploymentId: values[index] ? values[index]! : undefined,
      raw: values[index],
    }))
    // A key that expired between SCAN and MGET returns null — it is no longer live.
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

/**
 * Cycles a cross-deployment overlap must persist before it pages. Two cycles at
 * the default 5-minute interval is ~10 minutes — longer than any healthy deploy
 * drain, short enough that a stuck one is caught the same shift. Not tunable by
 * env: a knob nobody turns is a knob that rots.
 */
const DEPLOY_OVERLAP_GRACE_CYCLES = 2;

/** TTL multiple of the poll interval, so one missed cycle does not deregister a live replica. */
export const REPLICA_TTL_INTERVAL_MULTIPLE = 3;

let crossDeploymentCycles = 0;

/** Test seam — the counter is module state so the poller stays stateless. */
export function resetReplicaCardinalityState(): void {
  crossDeploymentCycles = 0;
}

/**
 * One cycle: refresh this replica's registration, read the live set, and decide.
 *
 * Returns null off-platform (no Railway identity → no invariant to police). The
 * CALLER is responsible for swallowing failures: a Redis outage must degrade to
 * "no replica alerting", never to a failed health cycle — that fail-safe
 * property is the reason this is a registry and not a boot-gating lease.
 */
export async function checkReplicaCardinality(
  redis: Redis,
  identity: ReplicaIdentity,
  options: { ttlSeconds: number; graceCycles?: number },
): Promise<HealthFinding | null> {
  if (!identity.onRailway || !identity.replicaId) return null;
  await heartbeatReplica(redis, identity, options.ttlSeconds);
  const replicas = await readLiveReplicas(redis, identity);
  crossDeploymentCycles = nextCrossDeploymentCycles(replicas, crossDeploymentCycles);
  return evaluateReplicaCardinality(
    replicas,
    crossDeploymentCycles,
    options.graceCycles ?? DEPLOY_OVERLAP_GRACE_CYCLES,
  );
}

/**
 * Decides whether the live set warrants paging. Pure — the poller owns the
 * Redis read and the cycle counter.
 *
 * Two distinct conditions, deliberately separated because they need different
 * urgency:
 *  - **scale_out** — replicas sharing a deployment id. Railway starts a new
 *    replica without redeploying the existing one, so this is the documented
 *    dashboard/CLI scale-out signal. It will not resolve itself: page now.
 *  - **deploy_overlap_stuck** — replicas on different deployment ids, still
 *    overlapping after `graceCycles`. Every release produces this shape briefly;
 *    one that outlives the grace window is a deploy that has not drained, and
 *    two replicas really are consuming jobs.
 */
export function evaluateReplicaCardinality(
  replicas: LiveReplica[],
  crossDeploymentCycles: number,
  graceCycles: number,
): HealthFinding | null {
  if (replicas.length < 2) return null;

  const replicaIds = replicas.map(({ replicaId }) => replicaId);
  const deploymentIds = [...new Set(replicas.map(({ deploymentId }) => deploymentId ?? '(none)'))];

  if (hasSharedDeployment(replicas)) {
    return {
      key: 'replica_cardinality',
      level: 'error',
      title: `${replicas.length} worker replicas are live under one deployment`,
      detail: {
        reason: 'scale_out',
        replica_count: replicas.length,
        replica_ids: replicaIds,
        deployment_ids: deploymentIds,
        remediation:
          'Scale the Railway worker service back to 1. Four boot guards and the ' +
          'in-process LLM circuit breaker assume a single replica, and the P2 ' +
          'pollers duplicate-process with two.',
      },
    };
  }

  if (crossDeploymentCycles < graceCycles) return null;

  return {
    key: 'replica_cardinality',
    level: 'error',
    title: `${replicas.length} worker replicas still overlapping across deployments`,
    detail: {
      reason: 'deploy_overlap_stuck',
      replica_count: replicas.length,
      replica_ids: replicaIds,
      deployment_ids: deploymentIds,
      consecutive_cycles: crossDeploymentCycles,
      remediation:
        'A zero-downtime deploy has not drained. Confirm the old deployment is ' +
        'terminating; both replicas are consuming jobs until it does.',
    },
  };
}

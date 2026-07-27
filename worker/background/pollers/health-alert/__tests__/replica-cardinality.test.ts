import { describe, expect, it } from 'vitest';
import {
  checkReplicaCardinality,
  evaluateReplicaCardinality,
  nextCrossDeploymentCycles,
  resetReplicaCardinalityState,
  type LiveReplica,
} from '../replica-cardinality';
import type { Redis } from 'ioredis';
import type { ReplicaIdentity } from '../../../../config/replica-identity';

const replica = (replicaId: string, deploymentId: string | undefined): LiveReplica => ({
  replicaId,
  deploymentId,
});

const GRACE = 2;

describe('evaluateReplicaCardinality — the invariant holds', () => {
  it.each([
    ['no replicas registered (Redis empty or unreachable)', []],
    ['exactly one replica', [replica('r1', 'd1')]],
  ])('returns null for %s', (_label, replicas) => {
    expect(evaluateReplicaCardinality(replicas as LiveReplica[], 0, GRACE)).toBeNull();
  });

  it('does not fire on a repeated single replica no matter how many cycles pass', () => {
    expect(evaluateReplicaCardinality([replica('r1', 'd1')], 99, GRACE)).toBeNull();
  });
});

describe('evaluateReplicaCardinality — scale-out under one deployment', () => {
  // The documented signal: Railway starts a new replica WITHOUT redeploying the
  // existing one, so a dashboard/CLI scale-out shows two replica ids sharing a
  // deployment id. Unambiguous, and it will not resolve on its own.
  it('fires immediately, without waiting out the grace window', () => {
    const finding = evaluateReplicaCardinality(
      [replica('r1', 'd1'), replica('r2', 'd1')],
      0,
      GRACE,
    );

    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('error');
    expect(finding!.key).toBe('replica_cardinality');
    expect(finding!.detail).toMatchObject({ replica_count: 2, reason: 'scale_out' });
  });

  it('reports every live replica id so the operator can identify the extra one', () => {
    const finding = evaluateReplicaCardinality(
      [replica('r1', 'd1'), replica('r2', 'd1')],
      0,
      GRACE,
    );

    expect(finding!.detail.replica_ids).toEqual(['r1', 'r2']);
  });

  it('fires when three replicas share a deployment', () => {
    const finding = evaluateReplicaCardinality(
      [replica('r1', 'd1'), replica('r2', 'd1'), replica('r3', 'd1')],
      0,
      GRACE,
    );

    expect(finding!.detail).toMatchObject({ replica_count: 3, reason: 'scale_out' });
  });

  it('treats a shared MISSING deployment id as one deployment', () => {
    // Both undefined is still "same deployment" for this purpose — two replicas
    // are running either way, and refusing to classify would silence the alert.
    const finding = evaluateReplicaCardinality(
      [replica('r1', undefined), replica('r2', undefined)],
      0,
      GRACE,
    );

    expect(finding).not.toBeNull();
    expect(finding!.detail).toMatchObject({ reason: 'scale_out' });
  });
});

describe('evaluateReplicaCardinality — zero-downtime deploy overlap', () => {
  // Old and new replicas run concurrently under DIFFERENT deployment ids during
  // every normal deploy. Alerting on that would page on every release, so it is
  // suppressed until it persists past the grace window — at which point the
  // deploy has not drained and two replicas really are consuming jobs.
  it('stays quiet inside the grace window', () => {
    const replicas = [replica('r1', 'd1'), replica('r2', 'd2')];

    expect(evaluateReplicaCardinality(replicas, 0, GRACE)).toBeNull();
    expect(evaluateReplicaCardinality(replicas, 1, GRACE)).toBeNull();
  });

  it('fires once the overlap has persisted for the grace window', () => {
    const finding = evaluateReplicaCardinality(
      [replica('r1', 'd1'), replica('r2', 'd2')],
      GRACE,
      GRACE,
    );

    expect(finding).not.toBeNull();
    expect(finding!.level).toBe('error');
    expect(finding!.detail).toMatchObject({
      replica_count: 2,
      reason: 'deploy_overlap_stuck',
      consecutive_cycles: GRACE,
    });
  });

  it('reports the distinct deployment ids for a stuck overlap', () => {
    const finding = evaluateReplicaCardinality(
      [replica('r1', 'd1'), replica('r2', 'd2')],
      GRACE,
      GRACE,
    );

    expect(finding!.detail.deployment_ids).toEqual(['d1', 'd2']);
  });

  it('classifies a partial overlap by the SHARED deployment, not the odd one out', () => {
    // Two replicas on d1 plus one mid-deploy on d2: the d1 pair is a scale-out
    // and must page now rather than wait out a grace window it did not cause.
    const finding = evaluateReplicaCardinality(
      [replica('r1', 'd1'), replica('r2', 'd1'), replica('r3', 'd2')],
      0,
      GRACE,
    );

    expect(finding!.detail).toMatchObject({ reason: 'scale_out' });
  });
});

describe('nextCrossDeploymentCycles', () => {
  it('counts up while a cross-deployment overlap persists', () => {
    expect(nextCrossDeploymentCycles([replica('r1', 'd1'), replica('r2', 'd2')], 0)).toBe(1);
    expect(nextCrossDeploymentCycles([replica('r1', 'd1'), replica('r2', 'd2')], 4)).toBe(5);
  });

  it.each([
    ['the overlap resolves', [replica('r1', 'd1')]],
    ['nothing is registered', []],
    ['the replicas share a deployment', [replica('r1', 'd1'), replica('r2', 'd1')]],
  ])('resets to zero when %s', (_label, replicas) => {
    expect(nextCrossDeploymentCycles(replicas as LiveReplica[], 7)).toBe(0);
  });
});

describe('checkReplicaCardinality — registry round trip', () => {
  interface FakeRedis {
    store: Map<string, string>;
    set: (key: string, value: string, mode: string, ttl: number) => Promise<'OK'>;
    scan: (cursor: string, ...args: unknown[]) => Promise<[string, string[]]>;
    mget: (...keys: string[]) => Promise<(string | null)[]>;
  }

  const fakeRedis = (seed: Record<string, string> = {}): FakeRedis => {
    const store = new Map(Object.entries(seed));
    return {
      store,
      set: async (key, value) => {
        store.set(key, value);
        return 'OK';
      },
      scan: async (_cursor, _match, pattern) => {
        const prefix = String(pattern).replace(/\*$/, '');
        return ['0', [...store.keys()].filter((key) => key.startsWith(prefix))];
      },
      mget: async (...keys) => keys.map((key) => store.get(key) ?? null),
    };
  };

  const identity: ReplicaIdentity = {
    replicaId: 'r1',
    deploymentId: 'd1',
    region: undefined,
    serviceName: 'worker',
    environmentName: 'production',
    onRailway: true,
  };

  // The fake implements only the three commands this module uses; cast through
  // unknown rather than `any` so the narrowing stays explicit (repworth.md).
  const run = (redis: FakeRedis, id = identity) =>
    checkReplicaCardinality(redis as unknown as Redis, id, { ttlSeconds: 900, graceCycles: GRACE });

  it('registers this replica under a scoped key with a TTL', async () => {
    const redis = fakeRedis();
    resetReplicaCardinalityState();

    await run(redis);

    expect([...redis.store.keys()]).toEqual(['repworth:replica:worker:production:r1']);
    expect(redis.store.get('repworth:replica:worker:production:r1')).toBe('d1');
  });

  it('returns null when this replica is the only one registered', async () => {
    resetReplicaCardinalityState();
    expect(await run(fakeRedis())).toBeNull();
  });

  it('pages when a second replica is registered under the same deployment', async () => {
    const redis = fakeRedis({ 'repworth:replica:worker:production:r2': 'd1' });
    resetReplicaCardinalityState();

    const finding = await run(redis);

    expect(finding!.detail).toMatchObject({ reason: 'scale_out', replica_count: 2 });
  });

  it('does not page on a fresh cross-deployment overlap, then does once it persists', async () => {
    const redis = fakeRedis({ 'repworth:replica:worker:production:r2': 'd2' });
    resetReplicaCardinalityState();

    expect(await run(redis)).toBeNull(); // cycle 1
    const finding = await run(redis); // cycle 2 — grace reached
    expect(finding!.detail).toMatchObject({ reason: 'deploy_overlap_stuck' });
  });

  it('ignores a key that expired between SCAN and MGET', async () => {
    const redis = fakeRedis({ 'repworth:replica:worker:production:r2': 'd1' });
    resetReplicaCardinalityState();
    redis.mget = async (...keys) => keys.map((key) => (key.endsWith(':r2') ? null : 'd1'));

    expect(await run(redis)).toBeNull();
  });

  it('registers nothing and returns null off-platform', async () => {
    const redis = fakeRedis();
    resetReplicaCardinalityState();

    const finding = await run(redis, { ...identity, onRailway: false, replicaId: undefined });

    expect(finding).toBeNull();
    expect(redis.store.size).toBe(0);
  });

  it('propagates a Redis failure so the CALLER can swallow it', async () => {
    // The fail-safe lives in the poller, not here — this asserts the contract
    // that a registry outage surfaces rather than silently reporting "healthy".
    const redis = fakeRedis();
    redis.scan = async () => { throw new Error('redis down'); };
    resetReplicaCardinalityState();

    await expect(run(redis)).rejects.toThrow('redis down');
  });
});

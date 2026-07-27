import { describe, it, expect } from 'vitest';
import { readReplicaIdentity, replicaIdentityFields, type ReplicaEnv } from '../replica-identity';

const RAILWAY_ENV = {
  RAILWAY_REPLICA_ID: 'replica-abc',
  RAILWAY_DEPLOYMENT_ID: 'deploy-123',
  RAILWAY_REPLICA_REGION: 'us-west2',
  RAILWAY_SERVICE_NAME: 'reporth-worker',
  RAILWAY_ENVIRONMENT_NAME: 'production',
} satisfies ReplicaEnv;

describe('readReplicaIdentity', () => {
  it('reads the Railway system variables', () => {
    expect(readReplicaIdentity(RAILWAY_ENV)).toEqual({
      replicaId: 'replica-abc',
      deploymentId: 'deploy-123',
      region: 'us-west2',
      serviceName: 'reporth-worker',
      environmentName: 'production',
      onRailway: true,
    });
  });

  it('reports onRailway=false for a local run with none of them set', () => {
    const identity = readReplicaIdentity({});
    expect(identity.onRailway).toBe(false);
    expect(identity.replicaId).toBeUndefined();
  });

  it('treats blank values as absent so a stray empty var cannot fake an identity', () => {
    expect(readReplicaIdentity({ RAILWAY_REPLICA_ID: '   ' }).onRailway).toBe(false);
  });

  it('is onRailway when only the deployment id is present', () => {
    expect(readReplicaIdentity({ RAILWAY_DEPLOYMENT_ID: 'deploy-123' }).onRailway).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(readReplicaIdentity({ RAILWAY_REPLICA_ID: ' replica-abc ' }).replicaId).toBe('replica-abc');
  });
});

describe('replicaIdentityFields', () => {
  it('maps every present value to its log/tag key', () => {
    expect(replicaIdentityFields(readReplicaIdentity(RAILWAY_ENV))).toEqual({
      replica_id: 'replica-abc',
      deployment_id: 'deploy-123',
      replica_region: 'us-west2',
      service_name: 'reporth-worker',
      railway_environment: 'production',
    });
  });

  it('emits nothing off-platform rather than a row of nulls', () => {
    expect(replicaIdentityFields(readReplicaIdentity({}))).toEqual({});
  });

  it('omits only the absent keys', () => {
    expect(replicaIdentityFields(readReplicaIdentity({ RAILWAY_REPLICA_ID: 'r1' }))).toEqual({
      replica_id: 'r1',
    });
  });

  // The detection contract: scaling up starts a second replica under the SAME
  // deployment, so two boot lines that agree on deployment_id and disagree on
  // replica_id are the signal the single-replica invariant was broken.
  it('distinguishes two replicas of one deployment', () => {
    const first = replicaIdentityFields(
      readReplicaIdentity({ RAILWAY_REPLICA_ID: 'r1', RAILWAY_DEPLOYMENT_ID: 'd1' }),
    );
    const second = replicaIdentityFields(
      readReplicaIdentity({ RAILWAY_REPLICA_ID: 'r2', RAILWAY_DEPLOYMENT_ID: 'd1' }),
    );
    expect(first.deployment_id).toBe(second.deployment_id);
    expect(first.replica_id).not.toBe(second.replica_id);
  });
});

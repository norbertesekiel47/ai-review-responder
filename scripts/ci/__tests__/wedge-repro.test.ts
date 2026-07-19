import { describe, expect, it } from 'vitest';

import {
  assertStagingTarget,
  describeConnectionTarget,
  KNOWN_STAGING_REF,
  PROD_PROJECT_REFS,
  runEmergencyCleanup,
} from '../../wedge-repro';

const STAGING_REF = KNOWN_STAGING_REF;
const PROD_REF = PROD_PROJECT_REFS[0];

// Realistic connection descriptors (user@host:port) as describeConnectionTarget builds them.
const STAGING_POOLER = `postgres.${STAGING_REF}@aws-0-us-west-1.pooler.supabase.com:6543`;
const STAGING_DIRECT = `postgres@db.${STAGING_REF}.supabase.co:5432`;
const PROD_POOLER = `postgres.${PROD_REF}@aws-0-us-west-1.pooler.supabase.com:6543`;
const PROD_DIRECT = `postgres@db.${PROD_REF}.supabase.co:5432`;

describe('assertStagingTarget', () => {
  it('accepts a matching staging target — pooler (ref in username) and direct (ref in host)', () => {
    expect(() => assertStagingTarget(STAGING_POOLER, STAGING_REF)).not.toThrow();
    expect(() => assertStagingTarget(STAGING_DIRECT, STAGING_REF)).not.toThrow();
  });

  it('is case-insensitive on the confirmed ref', () => {
    expect(() => assertStagingTarget(STAGING_POOLER, STAGING_REF.toUpperCase())).not.toThrow();
  });

  it('rejects a prod target even when a valid staging ref is confirmed (denylist wins)', () => {
    expect(() => assertStagingTarget(PROD_POOLER, STAGING_REF)).toThrow(/PRODUCTION project ref/);
    expect(() => assertStagingTarget(PROD_DIRECT, STAGING_REF)).toThrow(/PRODUCTION project ref/);
  });

  it('rejects a prod ref passed as the confirm value', () => {
    // Target host is innocuous, but the operator tried to confirm a prod ref.
    expect(() => assertStagingTarget(`postgres.${PROD_REF}@localhost:5432`, PROD_REF)).toThrow(
      /PRODUCTION project ref/,
    );
  });

  it('rejects a mismatch — confirmed ref not present in the target', () => {
    expect(() => assertStagingTarget(STAGING_POOLER, 'someotherstagingref00')).toThrow(
      /does not contain the confirmed staging ref/,
    );
  });

  it('rejects an empty / whitespace confirm ref', () => {
    expect(() => assertStagingTarget(STAGING_POOLER, '')).toThrow(/--confirm-staging/);
    expect(() => assertStagingTarget(STAGING_POOLER, '   ')).toThrow(/--confirm-staging/);
  });

  it('rejects an unknown ref that matches nothing in the target', () => {
    expect(() => assertStagingTarget(STAGING_DIRECT, 'unknownref')).toThrow(
      /does not contain the confirmed staging ref/,
    );
  });
});

describe('describeConnectionTarget', () => {
  it('extracts user@host:port from a pooler URL and never surfaces the password', () => {
    const target = describeConnectionTarget(
      `postgresql://postgres.${STAGING_REF}:sup3r-s3cr3t@aws-0-us-west-1.pooler.supabase.com:6543/postgres`,
    );
    expect(target).toBe(STAGING_POOLER);
    expect(target).not.toContain('sup3r-s3cr3t');
  });

  it('extracts the ref from a direct-connection host and hides the password', () => {
    const target = describeConnectionTarget(
      `postgresql://postgres:hunter2@db.${STAGING_REF}.supabase.co:5432/postgres`,
    );
    expect(target).toBe(STAGING_DIRECT);
    expect(target).not.toContain('hunter2');
  });

  it('throws on an unparseable URL', () => {
    expect(() => describeConnectionTarget('not a url')).toThrow(/not parseable/);
  });

  it('feeds the guard end-to-end: a prod URL is rejected regardless of confirm flag', () => {
    const target = describeConnectionTarget(
      `postgresql://postgres.${PROD_REF}:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres`,
    );
    expect(() => assertStagingTarget(target, STAGING_REF)).toThrow(/PRODUCTION project ref/);
  });
});

describe('runEmergencyCleanup (signal-path ordering — F3)', () => {
  it('kills worker children BEFORE terminating backends, THEN closes the observer', async () => {
    const order: string[] = [];
    await runEmergencyCleanup({
      killChildren: async () => {
        order.push('kill-children');
      },
      terminateBackends: async () => {
        order.push('terminate-backends');
      },
      closeObserver: async () => {
        order.push('close-observer');
      },
    });
    // Load-bearing: a child left alive can re-wedge backends AFTER the terminate
    // pass, so children must die first.
    expect(order).toEqual(['kill-children', 'terminate-backends', 'close-observer']);
  });

  it('still runs the later steps when an earlier step rejects', async () => {
    const order: string[] = [];
    await runEmergencyCleanup({
      killChildren: async () => {
        order.push('kill-children');
        throw new Error('child kill blew up');
      },
      terminateBackends: async () => {
        order.push('terminate-backends');
      },
      closeObserver: async () => {
        order.push('close-observer');
      },
    });
    expect(order).toEqual(['kill-children', 'terminate-backends', 'close-observer']);
  });
});

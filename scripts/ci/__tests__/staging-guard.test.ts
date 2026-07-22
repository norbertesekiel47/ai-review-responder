import { describe, expect, it } from 'vitest';

import {
  assertEphemeralBranchTarget,
  assertStagingTarget,
  describeConnectionTarget,
  KNOWN_STAGING_REF,
  PROD_PROJECT_REFS,
} from '../../staging-guard';

const STAGING_REF = KNOWN_STAGING_REF;
const PROD_REF = PROD_PROJECT_REFS[0];
const BRANCH_REF = 'branchref1234567890ab';

// Realistic connection descriptors (user@host:port) as describeConnectionTarget builds them.
const STAGING_POOLER = `postgres.${STAGING_REF}@aws-0-us-west-1.pooler.supabase.com:6543`;
const STAGING_DIRECT = `postgres@db.${STAGING_REF}.supabase.co:5432`;
const PROD_POOLER = `postgres.${PROD_REF}@aws-0-us-west-1.pooler.supabase.com:6543`;
const PROD_DIRECT = `postgres@db.${PROD_REF}.supabase.co:5432`;
const BRANCH_POOLER = `postgres.${BRANCH_REF}@aws-0-us-west-1.pooler.supabase.com:6543`;
const BRANCH_DIRECT = `postgres@db.${BRANCH_REF}.supabase.co:5432`;

describe('assertStagingTarget (positive allowlist — D2#7)', () => {
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

  it('rejects a non-prod, non-staging ref — must EQUAL the known staging ref, not merely appear in target', () => {
    expect(() => assertStagingTarget(STAGING_POOLER, 'someotherstagingref00')).toThrow(
      /does not match the known staging project ref/,
    );
    expect(() => assertStagingTarget(BRANCH_POOLER, BRANCH_REF)).toThrow(
      /does not match the known staging project ref/,
    );
  });

  it('rejects the known staging ref confirmed but absent from the target (containment still required)', () => {
    expect(() => assertStagingTarget('postgres@some-other-host:5432', STAGING_REF)).toThrow(
      /does not contain the confirmed staging ref/,
    );
  });

  it('rejects an empty / whitespace confirm ref', () => {
    expect(() => assertStagingTarget(STAGING_POOLER, '')).toThrow(/--confirm-staging/);
    expect(() => assertStagingTarget(STAGING_POOLER, '   ')).toThrow(/--confirm-staging/);
  });
});

describe('assertEphemeralBranchTarget (branch mode — D5)', () => {
  it('accepts a matching branch target distinct from prod and staging', () => {
    expect(() => assertEphemeralBranchTarget(BRANCH_POOLER, BRANCH_REF)).not.toThrow();
    expect(() => assertEphemeralBranchTarget(BRANCH_DIRECT, BRANCH_REF)).not.toThrow();
  });

  it('is case-insensitive on the confirmed ref', () => {
    expect(() => assertEphemeralBranchTarget(BRANCH_POOLER, BRANCH_REF.toUpperCase())).not.toThrow();
  });

  it('rejects a prod target even when a valid-shaped branch ref is confirmed (denylist wins)', () => {
    expect(() => assertEphemeralBranchTarget(PROD_POOLER, BRANCH_REF)).toThrow(/PRODUCTION project ref/);
    expect(() => assertEphemeralBranchTarget(PROD_DIRECT, BRANCH_REF)).toThrow(/PRODUCTION project ref/);
  });

  it('rejects a prod ref passed as the confirm value', () => {
    expect(() => assertEphemeralBranchTarget(`postgres.${PROD_REF}@localhost:5432`, PROD_REF)).toThrow(
      /PRODUCTION project ref/,
    );
  });

  it('rejects the KNOWN STAGING ref — a branch must be distinct from shared staging', () => {
    expect(() => assertEphemeralBranchTarget(STAGING_POOLER, STAGING_REF)).toThrow(
      /known STAGING project ref/,
    );
  });

  it('rejects a mismatch — confirmed branch ref not present in the target', () => {
    expect(() => assertEphemeralBranchTarget(BRANCH_POOLER, 'someotherbranchref00')).toThrow(
      /does not contain the confirmed branch ref/,
    );
  });

  it('rejects an empty / whitespace confirm ref', () => {
    expect(() => assertEphemeralBranchTarget(BRANCH_POOLER, '')).toThrow(/--confirm-branch/);
    expect(() => assertEphemeralBranchTarget(BRANCH_POOLER, '   ')).toThrow(/--confirm-branch/);
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

  it('feeds the guard end-to-end: a prod URL is rejected regardless of confirm flag (both modes)', () => {
    const target = describeConnectionTarget(
      `postgresql://postgres.${PROD_REF}:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres`,
    );
    expect(() => assertStagingTarget(target, STAGING_REF)).toThrow(/PRODUCTION project ref/);
    expect(() => assertEphemeralBranchTarget(target, BRANCH_REF)).toThrow(/PRODUCTION project ref/);
  });
});

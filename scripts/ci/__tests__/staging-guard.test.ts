import { describe, expect, it } from 'vitest';

import {
  assertEphemeralBranchTarget,
  assertMintTarget,
  assertStagingTarget,
  describeConnectionTarget,
  extractProjectRefForLog,
  KNOWN_STAGING_REF,
  PROD_PROJECT_REFS,
  PROJECT_REF_PATTERN,
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

// ── mode 3: assertMintTarget (#1178) ────────────────────────────────────────
//
// Moved here from scripts/mint-admin.ts on the owner's decision (2026-09-07,
// surface amendment #2): this module declares itself the single owner of "is
// this connection target safe", and a third mode living elsewhere made that
// docblock false (standards review finding M3).

const OTHER_REF = 'aaaabbbbccccddddeeee';
const STAGING_SUPABASE_URL = `https://${STAGING_REF}.supabase.co`;
const PROD_SUPABASE_URL = `https://${PROD_REF}.supabase.co`;
const PROD_DB_REF = PROD_REF;

describe('assertMintTarget (mint mode — #1178)', () => {
  it('accepts a staging target whose parsed refs both equal the confirmation', () => {
    expect(() =>
      assertMintTarget({
        supabaseUrl: STAGING_SUPABASE_URL,
        dbTarget: STAGING_POOLER,
        dbProjectRef: STAGING_REF,
        confirmRef: STAGING_REF,
      }),
    ).not.toThrow();
  });

  it('refuses when the Supabase host does not contain the confirmed project ref', () => {
    expect(() =>
      assertMintTarget({
        supabaseUrl: `https://${OTHER_REF}.supabase.co`,
        dbTarget: STAGING_POOLER,
        dbProjectRef: STAGING_REF,
        confirmRef: STAGING_REF,
      }),
    ).toThrow(/supabase/i);
  });

  it('refuses when the database target does not contain the confirmed project ref', () => {
    expect(() =>
      assertMintTarget({
        supabaseUrl: STAGING_SUPABASE_URL,
        dbTarget: `postgres.${OTHER_REF}@aws-0-us-west-1.pooler.supabase.com:6543`,
        dbProjectRef: OTHER_REF,
        confirmRef: STAGING_REF,
      }),
    ).toThrow(/database/i);
  });

  it('refuses a confirmed ref that is not a full Supabase project ref', () => {
    // The 16-, 19- and 21-character entries are LOAD-BEARING: they are the only
    // values that distinguish `{20}` from a loosened `{16,}`. Everything shorter
    // is rejected by either pattern, so a list of short refs alone lets that
    // widening survive — it did (red team RT-05).
    for (const partial of [
      'supabase',
      STAGING_REF.slice(0, 8),
      '',
      STAGING_REF.slice(0, 16),
      STAGING_REF.slice(0, 19),
      `${STAGING_REF}x`,
    ]) {
      expect(() =>
        assertMintTarget({
          supabaseUrl: STAGING_SUPABASE_URL,
          dbTarget: STAGING_POOLER,
          dbProjectRef: STAGING_REF,
          confirmRef: partial,
        }),
      ).toThrow(/complete Supabase project ref/i);
    }
  });

  it('refuses an unparseable database target — a sentinel can never confirm', () => {
    for (const sentinel of ['(ref-not-found)', '(unparseable)']) {
      expect(PROJECT_REF_PATTERN.test(sentinel)).toBe(false);
      expect(() =>
        assertMintTarget({
          supabaseUrl: STAGING_SUPABASE_URL,
          dbTarget: 'postgres@localhost:5432',
          dbProjectRef: sentinel,
          confirmRef: STAGING_REF,
        }),
      ).toThrow(/database/i);
    }
  });

  // ── the production path (owner decision 2026-09-07) ────────────────────────
  //
  // Ticket #1178 requires the script to serve BOTH projects. Production is
  // reachable, but only through an explicit selector AND a matching ref — two
  // independent controls, neither sufficient alone.

  it('refuses a production target when --env production is not selected', () => {
    for (const input of [
      { supabaseUrl: PROD_SUPABASE_URL, dbTarget: PROD_POOLER, dbProjectRef: PROD_DB_REF, confirmRef: PROD_REF },
      // Denylist beats a staging confirmation too — it is checked over the
      // ACTUAL targets, not just the confirmation.
      { supabaseUrl: PROD_SUPABASE_URL, dbTarget: STAGING_POOLER, dbProjectRef: STAGING_REF, confirmRef: STAGING_REF },
      { supabaseUrl: STAGING_SUPABASE_URL, dbTarget: PROD_POOLER, dbProjectRef: PROD_DB_REF, confirmRef: STAGING_REF },
    ]) {
      expect(() => assertMintTarget(input)).toThrow(/PRODUCTION project ref/);
      expect(() => assertMintTarget(input)).toThrow(/--env production/);
      // ...and explicitly NOT when the selector is on (that is the next test).
      expect(() => assertMintTarget({ ...input, allowProduction: false })).toThrow(/PRODUCTION/);
    }
  });

  it('refuses a production target when --confirm-ref does not match', () => {
    // The selector alone is NOT sufficient: every other check still applies.
    expect(() =>
      assertMintTarget({
        supabaseUrl: PROD_SUPABASE_URL,
        dbTarget: PROD_POOLER,
        dbProjectRef: PROD_DB_REF,
        confirmRef: STAGING_REF,
        allowProduction: true,
      }),
    ).toThrow(/not the confirmed/);

    expect(() =>
      assertMintTarget({
        supabaseUrl: PROD_SUPABASE_URL,
        dbTarget: PROD_POOLER,
        dbProjectRef: PROD_DB_REF,
        confirmRef: PROD_REF.slice(0, 16),
        allowProduction: true,
      }),
    ).toThrow(/complete Supabase project ref/i);

    // A mismatched pair is still a mismatched pair under the selector.
    expect(() =>
      assertMintTarget({
        supabaseUrl: PROD_SUPABASE_URL,
        dbTarget: STAGING_POOLER,
        dbProjectRef: STAGING_REF,
        confirmRef: PROD_REF,
        allowProduction: true,
      }),
    ).toThrow(/database/i);
  });

  it('accepts a production target under --env production with the matching ref', () => {
    expect(() =>
      assertMintTarget({
        supabaseUrl: PROD_SUPABASE_URL,
        dbTarget: PROD_POOLER,
        dbProjectRef: PROD_DB_REF,
        confirmRef: PROD_REF,
        allowProduction: true,
      }),
    ).not.toThrow();

    // The direct (non-pooler) host form too.
    expect(() =>
      assertMintTarget({
        supabaseUrl: PROD_SUPABASE_URL,
        dbTarget: PROD_DIRECT,
        dbProjectRef: PROD_DB_REF,
        confirmRef: PROD_REF,
        allowProduction: true,
      }),
    ).not.toThrow();
  });

  it('leaves the other two modes production-proof — the selector is mint-mode only', () => {
    // assertStagingTarget / assertEphemeralBranchTarget have no allowProduction
    // parameter and must stay unconditionally prod-denying.
    expect(() => assertStagingTarget(PROD_POOLER, STAGING_REF)).toThrow(/PRODUCTION/);
    expect(() => assertEphemeralBranchTarget(PROD_POOLER, BRANCH_REF)).toThrow(/PRODUCTION/);
  });
});

describe('extractProjectRefForLog — the parser assertMintTarget depends on', () => {
  it('parses the pooler user form, postgres.<ref>@…', () => {
    expect(
      extractProjectRefForLog(
        `postgres://postgres.${STAGING_REF}:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(STAGING_REF);
  });

  it('parses the direct host form, db.<ref>.supabase.co', () => {
    expect(
      extractProjectRefForLog(`postgres://postgres:pw@db.${STAGING_REF}.supabase.co:5432/postgres`),
    ).toBe(STAGING_REF);
  });

  it('returns a sentinel — never a bare ref — when it cannot parse one', () => {
    for (const url of ['postgres://user:pw@localhost:5432/postgres', 'not a url at all']) {
      const parsed = extractProjectRefForLog(url);
      expect(parsed).toMatch(/^\(.*\)$/);
      expect(PROJECT_REF_PATTERN.test(parsed)).toBe(false);
    }
  });
});

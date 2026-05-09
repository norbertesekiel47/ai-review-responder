/**
 * Structural validation test for migrations 040_rls_tightening.sql and
 * 041_rls_missing_revokes.sql
 *
 * Validates that the migrations tighten RLS write policies on businesses
 * and channel_enrollments per the security review findings. Reads the SQL
 * files and checks for:
 *
 * 1. businesses UPDATE policy narrowed to safe columns only
 *    (cannot update subscription_*, stripe_*, account_id, place_id, is_primary,
 *     archived_at, subscription_activated_at, place_id_verified, google_maps_url)
 * 2. channel_enrollments INSERT policy REMOVED
 *    (enrollments only go through verification flows via service-role key)
 * 3. channel_enrollments UPDATE policy narrowed to safe transitions only
 *    (can only update unsubscribed_at, unsubscribed_reason, updated_at)
 * 4. Sensitive column protection via REVOKE UPDATE from authenticated role
 *    (migration 040 covers original columns; migration 041 covers columns
 *     from earlier migrations that 040 missed)
 *
 * This is NOT a database integration test — it validates the SQL file structure.
 * Live DB validation requires psql with JWT claim injection.
 *
 * Run: pnpm test -- -t 'migration-040|migration-041'
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_040_PATH = resolve(
  process.cwd(),
  'supabase/migrations/040_rls_tightening.sql',
);

const MIGRATION_041_PATH = resolve(
  process.cwd(),
  'supabase/migrations/041_rls_missing_revokes.sql',
);

let sql040: string;
let sql041: string;
/** Combined SQL with comment lines stripped (avoids false positive matches on commented-out code). */
let sql040NoComments: string;
let sql041NoComments: string;
/** Combined SQL from both migrations (comments stripped). */
let combinedNoComments: string;

beforeAll(() => {
  sql040 = readFileSync(MIGRATION_040_PATH, 'utf-8');
  sql041 = readFileSync(MIGRATION_041_PATH, 'utf-8');
  // Strip SQL line comments (-- to end-of-line)
  sql040NoComments = sql040.replace(/--.*$/gm, '');
  sql041NoComments = sql041.replace(/--.*$/gm, '');
  combinedNoComments = sql040NoComments + '\n' + sql041NoComments;
});

// ── businesses UPDATE policy ────────────────────────────────────────────────

describe('migration 040 — businesses UPDATE policy tightening', () => {
  it('drops the old permissive businesses_owner_update policy', () => {
    expect(sql040NoComments).toMatch(
      /DROP POLICY IF EXISTS businesses_owner_update ON businesses/i,
    );
  });

  it('creates a new narrowed businesses_owner_update policy', () => {
    expect(sql040NoComments).toMatch(
      /CREATE POLICY businesses_owner_update ON businesses\s+FOR UPDATE TO authenticated/i,
    );
  });

  it('the new UPDATE policy uses account_id = owner_account_id() in USING clause', () => {
    const updateMatch = sql040NoComments.match(
      /CREATE POLICY businesses_owner_update ON businesses[\s\S]*?(?=DROP POLICY|CREATE POLICY|ALTER|DO \$|COMMENT|$)/i,
    );
    expect(updateMatch).toBeTruthy();
    expect(updateMatch![0]).toMatch(/USING \(account_id = owner_account_id\(\)\)/i);
  });

  it('the new UPDATE policy has a WITH CHECK clause', () => {
    const updateMatch = sql040NoComments.match(
      /CREATE POLICY businesses_owner_update ON businesses[\s\S]*?(?=DROP POLICY|CREATE POLICY|ALTER|DO \$|COMMENT|$)/i,
    );
    expect(updateMatch).toBeTruthy();
    expect(updateMatch![0]).toMatch(/WITH CHECK/i);
  });
});

// ── businesses: all sensitive columns REVOKE'd (across migrations 040 + 041) ──

describe('migrations 040+041 — businesses sensitive columns REVOKE check', () => {
  // Sensitive columns that MUST be REVOKE'd from authenticated role.
  // Columns revoked in migration 040:
  const sensitiveBusinessColumnsFrom040 = [
    'subscription_tier',
    'subscription_status',
    'stripe_customer_id',
    'stripe_subscription_id',
    'account_id',
    'google_place_id',
    'is_primary',
    'archived_at',
    'onboarded_by',
    'id',
    'name',
    'owner_name',
    'owner_email',
    'category',
    'initial_review_count',
    'initial_responded_count',
    'baseline_captured_at',
    'last_sync_at',
    'created_at',
  ];

  // Columns that migration 040 missed — added by earlier migrations (007, 014)
  // and revoked in migration 041:
  const sensitiveBusinessColumnsFrom041 = [
    'subscription_activated_at',  // migration 014 — managed by Stripe webhooks
    'place_id_verified',          // migration 007 — managed by PlaceIdValidationWorker
    'google_maps_url',            // migration 007 — managed by onboarding wizard guard
  ];

  it.each(sensitiveBusinessColumnsFrom040)(
    'REVOKEs UPDATE(%s) on businesses FROM authenticated (migration 040)',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON businesses FROM authenticated`,
        'i',
      );
      expect(sql040NoComments).toMatch(pattern);
    },
  );

  it.each(sensitiveBusinessColumnsFrom041)(
    'REVOKEs UPDATE(%s) on businesses FROM authenticated (migration 041)',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON businesses FROM authenticated`,
        'i',
      );
      expect(sql041NoComments).toMatch(pattern);
    },
  );

  // Combined check: ALL sensitive business columns are revoked across both migrations
  const allSensitiveBusinessColumns = [
    ...sensitiveBusinessColumnsFrom040,
    ...sensitiveBusinessColumnsFrom041,
  ];

  it.each(allSensitiveBusinessColumns)(
    'combined: UPDATE(%s) on businesses is REVOKEd from authenticated across migrations 040+041',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON businesses FROM authenticated`,
        'i',
      );
      expect(combinedNoComments).toMatch(pattern);
    },
  );

  // Safe columns that must NOT be revoked (owners CAN update these)
  const safeBusinessColumns = [
    'tone',
    'products_services',
    'staff_names',
    'highlight_facts',
    'avoid_facts',
    'sample_responses',
    'owner_phone',
    'notification_preference',
    'display_label',
    'updated_at',
  ];

  it.each(safeBusinessColumns)(
    'does NOT REVOKE UPDATE(%s) on businesses — owners can still update it',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON businesses FROM authenticated`,
        'i',
      );
      expect(combinedNoComments).not.toMatch(pattern);
    },
  );
});

// ── channel_enrollments INSERT policy ───────────────────────────────────────

describe('migration 040 — channel_enrollments INSERT policy removal', () => {
  it('drops the channel_enrollments_owner_insert policy', () => {
    expect(sql040NoComments).toMatch(
      /DROP POLICY IF EXISTS channel_enrollments_owner_insert ON channel_enrollments/i,
    );
  });

  it('does NOT recreate channel_enrollments_owner_insert', () => {
    expect(sql040NoComments).not.toMatch(
      /CREATE POLICY channel_enrollments_owner_insert ON channel_enrollments/i,
    );
  });

  it('owner cannot INSERT channel_enrollments with status=verified via anon key', () => {
    // Since the INSERT policy is removed, authenticated users with anon key
    // cannot insert any rows at all into channel_enrollments.
    const insertPolicyCount = (
      sql040NoComments.match(
        /CREATE POLICY.*owner_insert.*ON channel_enrollments/gi,
      ) || []
    ).length;
    expect(insertPolicyCount).toBe(0);
  });
});

// ── channel_enrollments UPDATE policy ───────────────────────────────────────

describe('migration 040 — channel_enrollments UPDATE policy narrowing', () => {
  it('drops the old permissive channel_enrollments_owner_update policy', () => {
    expect(sql040NoComments).toMatch(
      /DROP POLICY IF EXISTS channel_enrollments_owner_update ON channel_enrollments/i,
    );
  });

  it('creates a new narrowed channel_enrollments_owner_update policy', () => {
    expect(sql040NoComments).toMatch(
      /CREATE POLICY channel_enrollments_owner_update ON channel_enrollments\s+FOR UPDATE TO authenticated/i,
    );
  });

  it('owner cannot flip channel status via anon key UPDATE', () => {
    // Column-level REVOKE on status prevents authenticated users from
    // changing status even though they can update the row
    expect(sql040NoComments).toMatch(
      /REVOKE UPDATE \(status\) ON channel_enrollments FROM authenticated/i,
    );
  });

  it('owner cannot INSERT verified enrollments via anon key', () => {
    // INSERT policy is removed entirely
    const insertPolicies = sql040NoComments.match(
      /CREATE POLICY.*insert.*ON channel_enrollments/gi,
    );
    expect(insertPolicies).toBeFalsy();
  });
});

// ── channel_enrollments: all sensitive columns REVOKE'd (across migrations 040 + 041) ──

describe('migrations 040+041 — channel_enrollments sensitive columns REVOKE check', () => {
  // Columns revoked in migration 040:
  const sensitiveEnrollmentColumnsFrom040 = [
    'status',                       // prevents flipping to 'verified'
    'verified_at',                   // prevents self-verification
    'handle',                        // prevents changing communication handle
    'verification_token_hash',       // prevents forging verification tokens
    'verification_token_expires_at', // prevents extending token expiry
    'channel',                       // immutable after creation
    'account_id',                    // managed by server transactions
    'business_id',                   // managed by server transactions
    'location_id',                   // managed by server transactions
    'disabled_at',                   // managed by admin routes and workers
    'id',                            // never changeable
    'created_at',                    // immutable timestamp
  ];

  // Columns that migration 040 missed — added by migration 022
  // and revoked in migration 041:
  const sensitiveEnrollmentColumnsFrom041 = [
    'archived_at',    // migration 022 — owners must not un-archive admin-deleted enrollments
    'archive_reason', // migration 022 — owners must not rewrite archiving audit trail
  ];

  it.each(sensitiveEnrollmentColumnsFrom040)(
    'REVOKEs UPDATE(%s) on channel_enrollments FROM authenticated (migration 040)',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON channel_enrollments FROM authenticated`,
        'i',
      );
      expect(sql040NoComments).toMatch(pattern);
    },
  );

  it.each(sensitiveEnrollmentColumnsFrom041)(
    'REVOKEs UPDATE(%s) on channel_enrollments FROM authenticated (migration 041)',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON channel_enrollments FROM authenticated`,
        'i',
      );
      expect(sql041NoComments).toMatch(pattern);
    },
  );

  // Combined check: ALL sensitive enrollment columns are revoked across both migrations
  const allSensitiveEnrollmentColumns = [
    ...sensitiveEnrollmentColumnsFrom040,
    ...sensitiveEnrollmentColumnsFrom041,
  ];

  it.each(allSensitiveEnrollmentColumns)(
    'combined: UPDATE(%s) on channel_enrollments is REVOKEd from authenticated across migrations 040+041',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON channel_enrollments FROM authenticated`,
        'i',
      );
      expect(combinedNoComments).toMatch(pattern);
    },
  );

  // Safe columns that owners CAN update (opt-out mechanism)
  const safeEnrollmentColumns = [
    'unsubscribed_at',
    'unsubscribed_reason',
    'updated_at',
  ];

  it.each(safeEnrollmentColumns)(
    'does NOT REVOKE UPDATE(%s) on channel_enrollments — owners can still update it',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON channel_enrollments FROM authenticated`,
        'i',
      );
      expect(combinedNoComments).not.toMatch(pattern);
    },
  );
});

// ── Preservation of SELECT policies ─────────────────────────────────────────

describe('migration 040 — SELECT policies are preserved', () => {
  it('does NOT drop businesses_owner_select policy', () => {
    expect(sql040NoComments).not.toMatch(
      /DROP POLICY.*businesses_owner_select/i,
    );
  });

  it('does NOT drop channel_enrollments_owner_select policy', () => {
    expect(sql040NoComments).not.toMatch(
      /DROP POLICY.*channel_enrollments_owner_select/i,
    );
  });
});

// ── Migration 041 specific ──────────────────────────────────────────────────

describe('migration 041 — missing REVOKEs for columns from earlier migrations', () => {
  it('exists as a separate migration file', () => {
    // Migration 041 supplements migration 040 by revoking columns that were
    // added by earlier migrations (007, 014, 022) but missed in the initial
    // tightening pass.
    expect(sql041).toBeDefined();
    expect(sql041.length).toBeGreaterThan(0);
  });

  it('does NOT create or drop any RLS policies — only REVOKEs', () => {
    expect(sql041NoComments).not.toMatch(/CREATE POLICY/i);
    expect(sql041NoComments).not.toMatch(/DROP POLICY/i);
  });

  it('does NOT affect any table other than businesses and channel_enrollments', () => {
    const otherTables = ['accounts', 'api_costs', 'notification_deliveries',
      'approval_audit_log', 'reviews', 'responses', 'approval_links',
      'weekly_summaries', 'sms_sender_opt_outs'];

    for (const table of otherTables) {
      expect(sql041NoComments).not.toMatch(
        new RegExp(`ON ${table}`, 'i'),
      );
    }
  });

  it('all REVOKEs are inside a DO block for transactional safety', () => {
    expect(sql041NoComments).toMatch(/DO \$\$ BEGIN/i);
    expect(sql041NoComments).toMatch(/END \$\$;/);
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('migration 040 — idempotency', () => {
  it('uses DROP POLICY IF EXISTS before CREATE POLICY', () => {
    const createPolicies = sql040NoComments.match(/CREATE POLICY/gi) || [];
    const dropPolicies = sql040NoComments.match(/DROP POLICY IF EXISTS/gi) || [];
    expect(dropPolicies.length).toBeGreaterThanOrEqual(createPolicies.length);
  });

  it('REVOKE statements are safe to re-run (idempotent by default)', () => {
    // REVOKE is idempotent in PostgreSQL — revoking a privilege that is
    // already revoked is a no-op. No special idempotency guard needed.
    const revokeCount = (sql040NoComments.match(/REVOKE UPDATE/gi) || []).length;
    expect(revokeCount).toBeGreaterThan(0);
  });
});

describe('migration 041 — idempotency', () => {
  it('REVOKE statements are safe to re-run (idempotent by default)', () => {
    // REVOKE is idempotent in PostgreSQL — revoking a privilege that is
    // already revoked is a no-op. Running migration 041 multiple times
    // has the same effect as running it once.
    const revokeCount = (sql041NoComments.match(/REVOKE UPDATE/gi) || []).length;
    expect(revokeCount).toBe(5); // 3 on businesses + 2 on channel_enrollments
  });
});

// ── Combined state after migrations 035 + 040 + 041 ──────────────────────

describe('combined state — migrations 035 + 040 + 041', () => {
  // Read migration 035 as well to verify the final combined state
  const migration035Path = resolve(
    process.cwd(),
    'supabase/migrations/035_rls_policies.sql',
  );
  let sql035: string;
  let sql035NoComments: string;

  beforeAll(() => {
    sql035 = readFileSync(migration035Path, 'utf-8');
    sql035NoComments = sql035.replace(/--.*$/gm, '');
  });

  it('businesses has exactly SELECT + UPDATE policies (no INSERT/DELETE)', () => {
    // Migration 035 creates: businesses_owner_select, businesses_owner_update
    // Migration 040 drops and recreates: businesses_owner_update (narrowed)
    // Migration 041 adds column REVOKES only (no policy changes)
    // No INSERT or DELETE policy on businesses
    const combined = sql035NoComments + '\n' + sql040NoComments + '\n' + sql041NoComments;

    const selectCount = (combined.match(/CREATE POLICY businesses_owner_select/gi) || []).length;
    const updateCount = (combined.match(/CREATE POLICY businesses_owner_update/gi) || []).length;
    const insertCount = (combined.match(/CREATE POLICY businesses_owner_insert/gi) || []).length;
    const deleteCount = (combined.match(/CREATE POLICY businesses_owner_delete/gi) || []).length;

    expect(selectCount).toBeGreaterThanOrEqual(1);
    expect(updateCount).toBeGreaterThanOrEqual(1);
    expect(insertCount).toBe(0);
    expect(deleteCount).toBe(0);
  });

  it('channel_enrollments has SELECT + UPDATE policies only (INSERT removed)', () => {
    // Migration 035 creates: select, insert, update
    // Migration 040 drops: insert, and drops+recreates update (narrowed)
    // Migration 041 adds column REVOKES only (no policy changes)
    // Final state: select + update (no insert)
    const combined = sql035NoComments + '\n' + sql040NoComments + '\n' + sql041NoComments;

    const selectCount = (combined.match(/CREATE POLICY channel_enrollments_owner_select/gi) || []).length;
    const updateCount = (combined.match(/CREATE POLICY channel_enrollments_owner_update/gi) || []).length;

    expect(selectCount).toBeGreaterThanOrEqual(1);
    expect(updateCount).toBeGreaterThanOrEqual(1);

    // INSERT policy is created in 035 but dropped in 040
    expect(sql040NoComments).toMatch(
      /DROP POLICY IF EXISTS channel_enrollments_owner_insert ON channel_enrollments/i,
    );
    expect(sql040NoComments).not.toMatch(
      /CREATE POLICY channel_enrollments_owner_insert ON channel_enrollments/i,
    );
  });

  it('all other table policies from migration 035 are untouched', () => {
    // Migrations 040 and 041 should NOT affect any other table's policies
    const affectedTables = ['accounts', 'api_costs', 'notification_deliveries',
      'approval_audit_log', 'account_audit_log', 'reviews', 'responses',
      'approval_links', 'weekly_summaries', 'review_exceptions',
      'ranking_snapshots', 'monthly_impact_emails', 'onboarding_drip_log',
      'satisfaction_responses', 'api_costs_daily_rollups', 'zernio_connections',
      'zernio_finalize_incidents', 'zernio_backfill_runs', 'sms_sender_opt_outs',
      'sms_sender_opt_out_events'];

    for (const table of affectedTables) {
      expect(sql040NoComments).not.toMatch(
        new RegExp(`DROP POLICY.*ON ${table}`, 'i'),
      );
      expect(sql040NoComments).not.toMatch(
        new RegExp(`REVOKE.*ON ${table}`, 'i'),
      );
      expect(sql041NoComments).not.toMatch(
        new RegExp(`REVOKE.*ON ${table}`, 'i'),
      );
    }
  });

  it('total REVOKE count across 040+041 covers all sensitive columns', () => {
    // Migration 040: 19 REVOKEs on businesses + 12 on channel_enrollments = 31
    // Migration 041: 3 REVOKEs on businesses + 2 on channel_enrollments = 5
    // Total: 36 REVOKE UPDATE statements
    const businessesRevokes = (combinedNoComments.match(
      /REVOKE UPDATE \([^)]+\) ON businesses FROM authenticated/gi,
    ) || []).length;
    const enrollmentRevokes = (combinedNoComments.match(
      /REVOKE UPDATE \([^)]+\) ON channel_enrollments FROM authenticated/gi,
    ) || []).length;

    expect(businessesRevokes).toBe(22); // 19 from 040 + 3 from 041
    expect(enrollmentRevokes).toBe(14); // 12 from 040 + 2 from 041
  });
});

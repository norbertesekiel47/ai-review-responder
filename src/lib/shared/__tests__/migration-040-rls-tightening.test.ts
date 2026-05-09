/**
 * Structural validation test for migration 040_rls_tightening.sql
 *
 * Validates that the migration tightens RLS write policies on businesses
 * and channel_enrollments per the security review findings. Reads the SQL
 * file and checks for:
 *
 * 1. businesses UPDATE policy narrowed to safe columns only
 *    (cannot update subscription_*, stripe_*, account_id, place_id, is_primary, archived_at)
 * 2. channel_enrollments INSERT policy REMOVED
 *    (enrollments only go through verification flows via service-role key)
 * 3. channel_enrollments UPDATE policy narrowed to safe transitions only
 *    (can only update unsubscribed_at, unsubscribed_reason, updated_at)
 * 4. Sensitive column protection via REVOKE UPDATE from authenticated role
 *
 * This is NOT a database integration test — it validates the SQL file structure.
 * Live DB validation requires psql with JWT claim injection.
 *
 * Run: pnpm test -- -t 'migration 040'
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/040_rls_tightening.sql',
);

let sql: string;
/** SQL with comment lines stripped (avoids false positive matches on commented-out code). */
let sqlNoComments: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  // Strip SQL line comments (-- to end-of-line)
  sqlNoComments = sql.replace(/--.*$/gm, '');
});

// ── businesses UPDATE policy ────────────────────────────────────────────────

describe('migration 040 — businesses UPDATE policy tightening', () => {
  it('drops the old permissive businesses_owner_update policy', () => {
    expect(sqlNoComments).toMatch(
      /DROP POLICY IF EXISTS businesses_owner_update ON businesses/i,
    );
  });

  it('creates a new narrowed businesses_owner_update policy', () => {
    expect(sqlNoComments).toMatch(
      /CREATE POLICY businesses_owner_update ON businesses\s+FOR UPDATE TO authenticated/i,
    );
  });

  it('the new UPDATE policy uses account_id = owner_account_id() in USING clause', () => {
    const updateMatch = sqlNoComments.match(
      /CREATE POLICY businesses_owner_update ON businesses[\s\S]*?(?=DROP POLICY|CREATE POLICY|ALTER|DO \$|COMMENT|$)/i,
    );
    expect(updateMatch).toBeTruthy();
    expect(updateMatch![0]).toMatch(/USING \(account_id = owner_account_id\(\)\)/i);
  });

  it('the new UPDATE policy has a WITH CHECK clause', () => {
    const updateMatch = sqlNoComments.match(
      /CREATE POLICY businesses_owner_update ON businesses[\s\S]*?(?=DROP POLICY|CREATE POLICY|ALTER|DO \$|COMMENT|$)/i,
    );
    expect(updateMatch).toBeTruthy();
    expect(updateMatch![0]).toMatch(/WITH CHECK/i);
  });

  // Sensitive columns that MUST be REVOKE'd from authenticated role
  const sensitiveBusinessColumns = [
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

  it.each(sensitiveBusinessColumns)(
    'REVOKEs UPDATE(%s) on businesses FROM authenticated',
    (col) => {
      // Column-level REVOKE prevents authenticated users from writing
      // this column even though the RLS policy allows UPDATE on the row.
      // Service-role (table owner) bypasses column-level privileges.
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON businesses FROM authenticated`,
        'i',
      );
      expect(sqlNoComments).toMatch(pattern);
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
      expect(sqlNoComments).not.toMatch(pattern);
    },
  );
});

// ── channel_enrollments INSERT policy ───────────────────────────────────────

describe('migration 040 — channel_enrollments INSERT policy removal', () => {
  it('drops the channel_enrollments_owner_insert policy', () => {
    expect(sqlNoComments).toMatch(
      /DROP POLICY IF EXISTS channel_enrollments_owner_insert ON channel_enrollments/i,
    );
  });

  it('does NOT recreate channel_enrollments_owner_insert', () => {
    expect(sqlNoComments).not.toMatch(
      /CREATE POLICY channel_enrollments_owner_insert ON channel_enrollments/i,
    );
  });

  it('owner cannot INSERT channel_enrollments with status=verified via anon key', () => {
    // Since the INSERT policy is removed, authenticated users with anon key
    // cannot insert any rows at all into channel_enrollments.
    const insertPolicyCount = (
      sqlNoComments.match(
        /CREATE POLICY.*owner_insert.*ON channel_enrollments/gi,
      ) || []
    ).length;
    expect(insertPolicyCount).toBe(0);
  });
});

// ── channel_enrollments UPDATE policy ───────────────────────────────────────

describe('migration 040 — channel_enrollments UPDATE policy narrowing', () => {
  it('drops the old permissive channel_enrollments_owner_update policy', () => {
    expect(sqlNoComments).toMatch(
      /DROP POLICY IF EXISTS channel_enrollments_owner_update ON channel_enrollments/i,
    );
  });

  it('creates a new narrowed channel_enrollments_owner_update policy', () => {
    expect(sqlNoComments).toMatch(
      /CREATE POLICY channel_enrollments_owner_update ON channel_enrollments\s+FOR UPDATE TO authenticated/i,
    );
  });

  // Sensitive columns that MUST be REVOKE'd from authenticated role
  const sensitiveEnrollmentColumns = [
    'status',                      // prevents flipping to 'verified'
    'verified_at',                  // prevents self-verification
    'handle',                       // prevents changing communication handle
    'verification_token_hash',      // prevents forging verification tokens
    'verification_token_expires_at',// prevents extending token expiry
    'channel',                      // immutable after creation
    'account_id',                   // managed by server transactions
    'business_id',                  // managed by server transactions
    'location_id',                  // managed by server transactions
    'disabled_at',                  // managed by admin routes and workers
    'id',                           // never changeable
    'created_at',                   // immutable timestamp
  ];

  it.each(sensitiveEnrollmentColumns)(
    'REVOKEs UPDATE(%s) on channel_enrollments FROM authenticated',
    (col) => {
      const pattern = new RegExp(
        `REVOKE UPDATE \\(${col}\\) ON channel_enrollments FROM authenticated`,
        'i',
      );
      expect(sqlNoComments).toMatch(pattern);
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
      expect(sqlNoComments).not.toMatch(pattern);
    },
  );

  it('owner cannot flip channel status via anon key UPDATE', () => {
    // Column-level REVOKE on status prevents authenticated users from
    // changing status even though they can update the row
    expect(sqlNoComments).toMatch(
      /REVOKE UPDATE \(status\) ON channel_enrollments FROM authenticated/i,
    );
  });

  it('owner cannot INSERT verified enrollments via anon key', () => {
    // INSERT policy is removed entirely
    const insertPolicies = sqlNoComments.match(
      /CREATE POLICY.*insert.*ON channel_enrollments/gi,
    );
    expect(insertPolicies).toBeFalsy();
  });
});

// ── Preservation of SELECT policies ─────────────────────────────────────────

describe('migration 040 — SELECT policies are preserved', () => {
  it('does NOT drop businesses_owner_select policy', () => {
    expect(sqlNoComments).not.toMatch(
      /DROP POLICY.*businesses_owner_select/i,
    );
  });

  it('does NOT drop channel_enrollments_owner_select policy', () => {
    expect(sqlNoComments).not.toMatch(
      /DROP POLICY.*channel_enrollments_owner_select/i,
    );
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('migration 040 — idempotency', () => {
  it('uses DROP POLICY IF EXISTS before CREATE POLICY', () => {
    const createPolicies = sqlNoComments.match(/CREATE POLICY/gi) || [];
    const dropPolicies = sqlNoComments.match(/DROP POLICY IF EXISTS/gi) || [];
    expect(dropPolicies.length).toBeGreaterThanOrEqual(createPolicies.length);
  });

  it('REVOKE statements are safe to re-run (idempotent by default)', () => {
    // REVOKE is idempotent in PostgreSQL — revoking a privilege that is
    // already revoked is a no-op. No special idempotency guard needed.
    const revokeCount = (sqlNoComments.match(/REVOKE UPDATE/gi) || []).length;
    expect(revokeCount).toBeGreaterThan(0);
  });
});

// ── Combined state after migrations 035 + 040 ──────────────────────────────

describe('migration 040 — combined state with migration 035', () => {
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
    // No INSERT or DELETE policy on businesses
    const combined = sql035NoComments + '\n' + sqlNoComments;

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
    // Final state: select + update (no insert)
    const combined = sql035NoComments + '\n' + sqlNoComments;

    const selectCount = (combined.match(/CREATE POLICY channel_enrollments_owner_select/gi) || []).length;
    const updateCount = (combined.match(/CREATE POLICY channel_enrollments_owner_update/gi) || []).length;

    expect(selectCount).toBeGreaterThanOrEqual(1);
    expect(updateCount).toBeGreaterThanOrEqual(1);

    // INSERT policy is created in 035 but dropped in 040
    expect(sqlNoComments).toMatch(
      /DROP POLICY IF EXISTS channel_enrollments_owner_insert ON channel_enrollments/i,
    );
    expect(sqlNoComments).not.toMatch(
      /CREATE POLICY channel_enrollments_owner_insert ON channel_enrollments/i,
    );
  });

  it('all other table policies from migration 035 are untouched', () => {
    // Migration 040 should NOT affect any other table's policies
    const affectedTables = ['accounts', 'api_costs', 'notification_deliveries',
      'approval_audit_log', 'account_audit_log', 'reviews', 'responses',
      'approval_links', 'weekly_summaries', 'review_exceptions',
      'ranking_snapshots', 'monthly_impact_emails', 'onboarding_drip_log',
      'satisfaction_responses', 'api_costs_daily_rollups', 'zernio_connections',
      'zernio_finalize_incidents', 'zernio_backfill_runs', 'sms_sender_opt_outs',
      'sms_sender_opt_out_events'];

    for (const table of affectedTables) {
      expect(sqlNoComments).not.toMatch(
        new RegExp(`DROP POLICY.*ON ${table}`, 'i'),
      );
      expect(sqlNoComments).not.toMatch(
        new RegExp(`REVOKE.*ON ${table}`, 'i'),
      );
    }
  });
});

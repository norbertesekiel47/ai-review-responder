/**
 * Structural validation test for migration 035_rls_policies.sql
 *
 * Validates that the migration SQL file contains all required RLS policy
 * statements per the validation contract (VAL-AUTH-001 through VAL-AUTH-022,
 * VAL-AUTH-035). Reads the SQL file and checks for:
 *   - Helper function owner_account_id()
 *   - RLS policies on each protected table with correct predicate pattern
 *   - Correct operations (SELECT, INSERT, UPDATE) per table
 *   - users_self_select policy preservation
 *
 * This is NOT a database integration test — it cannot verify that the policies
 * actually enforce cross-account isolation against a live database. That must
 * be done manually via psql with SET jwt.claims.sub (see verification steps).
 * Instead, it catches accidental deletions, wrong predicates, or missing policies.
 *
 * Run: pnpm test -- migration-035
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/035_rls_policies.sql',
);

let sql: string;
/** SQL with comment lines stripped (avoids false positive matches on commented-out code). */
let sqlNoComments: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  // Strip SQL line comments (-- to end-of-line) so we only match active DDL
  sqlNoComments = sql.replace(/--.*$/gm, '');
});

// ── Helper function ──────────────────────────────────────────────────────────

describe('migration 035 — owner_account_id() helper function', () => {
  it('creates the owner_account_id() function', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION owner_account_id\(\)/i);
  });

  it('returns UUID type', () => {
    expect(sql).toMatch(/RETURNS UUID/i);
  });

  it('is STABLE (evaluated once per statement)', () => {
    expect(sql).toMatch(/LANGUAGE sql\s+STABLE/i);
  });

  it('queries users.account_id WHERE auth_id = auth.uid()::text', () => {
    expect(sql).toMatch(
      /SELECT account_id FROM users WHERE auth_id = auth\.uid\(\)::text/i,
    );
  });
});

// ── Group 1: Tables with direct account_id ──────────────────────────────────

describe('migration 035 — Group 1: direct account_id tables', () => {
  // VAL-AUTH-001: accounts
  describe('accounts (VAL-AUTH-001)', () => {
    it('has SELECT policy for authenticated role', () => {
      expect(sql).toMatch(
        /CREATE POLICY accounts_owner_select ON accounts\s+FOR SELECT TO authenticated/i,
      );
    });

    it('uses id = owner_account_id() predicate (accounts.id IS the account_id)', () => {
      expect(sql).toMatch(/USING \(id = owner_account_id\(\)\)/i);
    });

    it('does NOT have INSERT/UPDATE/DELETE policies', () => {
      expect(sql).not.toMatch(/CREATE POLICY accounts_owner_insert/i);
      expect(sql).not.toMatch(/CREATE POLICY accounts_owner_update/i);
      expect(sql).not.toMatch(/CREATE POLICY accounts_owner_delete/i);
    });
  });

  // VAL-AUTH-002: businesses
  describe('businesses (VAL-AUTH-002)', () => {
    it('has SELECT policy for authenticated role', () => {
      expect(sql).toMatch(
        /CREATE POLICY businesses_owner_select ON businesses\s+FOR SELECT TO authenticated/i,
      );
    });

    it('has UPDATE policy for authenticated role', () => {
      expect(sql).toMatch(
        /CREATE POLICY businesses_owner_update ON businesses\s+FOR UPDATE TO authenticated/i,
      );
    });

    it('SELECT policy uses account_id = owner_account_id()', () => {
      const selectMatch = sql.match(
        /CREATE POLICY businesses_owner_select[\s\S]*?USING \([^)]+\)/i,
      );
      expect(selectMatch).toBeTruthy();
      expect(selectMatch![0]).toMatch(/account_id = owner_account_id\(\)/i);
    });

    it('UPDATE policy has both USING and WITH CHECK', () => {
      const updateMatch = sql.match(
        /CREATE POLICY businesses_owner_update[\s\S]*?(?=CREATE POLICY|DROP POLICY|--)/i,
      );
      expect(updateMatch).toBeTruthy();
      expect(updateMatch![0]).toMatch(/USING \(account_id = owner_account_id\(\)\)/i);
      expect(updateMatch![0]).toMatch(/WITH CHECK \(account_id = owner_account_id\(\)\)/i);
    });
  });

  // VAL-AUTH-003: channel_enrollments
  describe('channel_enrollments (VAL-AUTH-003)', () => {
    it('has SELECT policy', () => {
      expect(sql).toMatch(
        /CREATE POLICY channel_enrollments_owner_select ON channel_enrollments\s+FOR SELECT TO authenticated/i,
      );
    });

    it('has INSERT policy with WITH CHECK', () => {
      expect(sql).toMatch(
        /CREATE POLICY channel_enrollments_owner_insert ON channel_enrollments\s+FOR INSERT TO authenticated/i,
      );
      const insertMatch = sql.match(
        /CREATE POLICY channel_enrollments_owner_insert[\s\S]*?WITH CHECK \([^)]+\)/i,
      );
      expect(insertMatch).toBeTruthy();
      expect(insertMatch![0]).toMatch(/account_id = owner_account_id\(\)/i);
    });

    it('has UPDATE policy with USING and WITH CHECK', () => {
      expect(sql).toMatch(
        /CREATE POLICY channel_enrollments_owner_update ON channel_enrollments\s+FOR UPDATE TO authenticated/i,
      );
      const updateMatch = sql.match(
        /CREATE POLICY channel_enrollments_owner_update[\s\S]*?(?=DROP POLICY|CREATE POLICY|--)/i,
      );
      expect(updateMatch).toBeTruthy();
      expect(updateMatch![0]).toMatch(/USING \(account_id = owner_account_id\(\)\)/i);
      expect(updateMatch![0]).toMatch(/WITH CHECK \(account_id = owner_account_id\(\)\)/i);
    });
  });

  // VAL-AUTH-004: api_costs
  describe('api_costs (VAL-AUTH-004)', () => {
    it('has SELECT policy with account_id predicate', () => {
      expect(sql).toMatch(
        /CREATE POLICY api_costs_owner_select ON api_costs\s+FOR SELECT TO authenticated\s+USING \(account_id = owner_account_id\(\)\)/i,
      );
    });
  });

  // VAL-AUTH-005: notification_deliveries
  describe('notification_deliveries (VAL-AUTH-005)', () => {
    it('has SELECT policy with account_id predicate', () => {
      expect(sql).toMatch(
        /CREATE POLICY notification_deliveries_owner_select ON notification_deliveries\s+FOR SELECT TO authenticated\s+USING \(account_id = owner_account_id\(\)\)/i,
      );
    });
  });

  // VAL-AUTH-006: approval_audit_log
  describe('approval_audit_log (VAL-AUTH-006)', () => {
    it('has SELECT policy with account_id predicate', () => {
      expect(sql).toMatch(
        /CREATE POLICY approval_audit_log_owner_select ON approval_audit_log\s+FOR SELECT TO authenticated\s+USING \(account_id = owner_account_id\(\)\)/i,
      );
    });
  });

  // VAL-AUTH-035: account_audit_log
  describe('account_audit_log (VAL-AUTH-035)', () => {
    it('has SELECT policy with account_id predicate', () => {
      expect(sql).toMatch(
        /CREATE POLICY account_audit_log_owner_select ON account_audit_log\s+FOR SELECT TO authenticated\s+USING \(account_id = owner_account_id\(\)\)/i,
      );
    });
  });
});

// ── Group 2: Tables scoped by business_id (JOIN predicate) ──────────────────

describe('migration 035 — Group 2: business_id JOIN tables', () => {
  const joinPredicatePattern =
    /business_id IN \(SELECT id FROM businesses WHERE account_id = owner_account_id\(\)\)/i;

  const businessScopedTables = [
    { table: 'reviews', assertion: 'VAL-AUTH-007' },
    { table: 'responses', assertion: 'VAL-AUTH-008' },
    { table: 'approval_links', assertion: 'VAL-AUTH-009' },
    { table: 'weekly_summaries', assertion: 'VAL-AUTH-010' },
    { table: 'review_exceptions', assertion: 'VAL-AUTH-011' },
    { table: 'ranking_snapshots', assertion: 'VAL-AUTH-012' },
    { table: 'monthly_impact_emails', assertion: 'VAL-AUTH-013' },
    { table: 'onboarding_drip_log', assertion: 'VAL-AUTH-014' },
    { table: 'satisfaction_responses', assertion: 'VAL-AUTH-015' },
    { table: 'api_costs_daily_rollups', assertion: 'VAL-AUTH-016' },
    { table: 'zernio_connections', assertion: 'VAL-AUTH-019' },
    { table: 'zernio_finalize_incidents', assertion: 'VAL-AUTH-020' },
    { table: 'zernio_backfill_runs', assertion: 'VAL-AUTH-021' },
  ];

  it.each(businessScopedTables)(
    '$assertion: $table has SELECT policy with business_id JOIN predicate',
    ({ table }) => {
      const policyPattern = new RegExp(
        `CREATE POLICY ${table}_owner_select ON ${table}\\s+FOR SELECT TO authenticated\\s+USING \\(business_id IN \\(SELECT id FROM businesses WHERE account_id = owner_account_id\\(\\)\\)\\)`,
        'i',
      );
      expect(sql).toMatch(policyPattern);
    },
  );

  it('all business-scoped tables are SELECT-only (no INSERT/UPDATE/DELETE)', () => {
    for (const { table } of businessScopedTables) {
      expect(sql).not.toMatch(
        new RegExp(`CREATE POLICY ${table}_owner_insert`, 'i'),
      );
      expect(sql).not.toMatch(
        new RegExp(`CREATE POLICY ${table}_owner_update`, 'i'),
      );
      expect(sql).not.toMatch(
        new RegExp(`CREATE POLICY ${table}_owner_delete`, 'i'),
      );
    }
  });
});

// ── Group 3: SMS tables (channel_enrollments.handle bridge) ─────────────────

describe('migration 035 — Group 3: SMS tables via channel_enrollments.handle', () => {
  // VAL-AUTH-017: sms_sender_opt_outs
  describe('sms_sender_opt_outs (VAL-AUTH-017)', () => {
    it('has SELECT policy', () => {
      expect(sqlNoComments).toMatch(
        /CREATE POLICY sms_sender_opt_outs_owner_select ON sms_sender_opt_outs\s+FOR SELECT TO authenticated/i,
      );
    });

    it('uses handle IN (channel_enrollments subquery)', () => {
      expect(sqlNoComments).toMatch(
        /USING \(handle IN \(\s*SELECT ce\.handle FROM channel_enrollments ce/i,
      );
    });

    it('subquery filters by owner_account_id() and SMS/WhatsApp channels', () => {
      // Find the full policy text from CREATE to the closing paren of USING
      const policyIdx = sqlNoComments.indexOf('CREATE POLICY sms_sender_opt_outs_owner_select');
      const afterCreate = sqlNoComments.slice(policyIdx);
      // Match USING ( ... ) accounting for nested parens
      const usingMatch = afterCreate.match(/USING \([\s\S]*?\n\s*\)/);
      expect(usingMatch).toBeTruthy();
      const predicate = usingMatch![0];
      expect(predicate).toMatch(/ce\.account_id = owner_account_id\(\)/i);
      expect(predicate).toMatch(/ce\.channel IN \('sms',\s*'whatsapp'\)/i);
      expect(predicate).toMatch(/ce\.handle IS NOT NULL/i);
      expect(predicate).toMatch(/ce\.archived_at IS NULL/i);
    });
  });

  // VAL-AUTH-018: sms_sender_opt_out_events
  describe('sms_sender_opt_out_events (VAL-AUTH-018)', () => {
    it('has SELECT policy', () => {
      expect(sqlNoComments).toMatch(
        /CREATE POLICY sms_sender_opt_out_events_owner_select ON sms_sender_opt_out_events\s+FOR SELECT TO authenticated/i,
      );
    });

    it('uses same handle IN subquery pattern as sms_sender_opt_outs', () => {
      const policyIdx = sqlNoComments.indexOf('CREATE POLICY sms_sender_opt_out_events_owner_select');
      const afterCreate = sqlNoComments.slice(policyIdx);
      const usingMatch = afterCreate.match(/USING \([\s\S]*?\n\s*\)/);
      expect(usingMatch).toBeTruthy();
      const predicate = usingMatch![0];
      expect(predicate).toMatch(/handle IN/i);
      expect(predicate).toMatch(/channel_enrollments ce/i);
      expect(predicate).toMatch(/ce\.account_id = owner_account_id\(\)/i);
    });
  });
});

// ── users_self_select preservation ───────────────────────────────────────────

describe('migration 035 — users_self_select policy preservation', () => {
  it('does NOT drop the users_self_select policy', () => {
    expect(sql).not.toMatch(/DROP POLICY.*users_self_select/i);
  });

  it('does NOT create a new policy on the users table', () => {
    // Use sqlNoComments to avoid matching the comment that describes the existing policy
    expect(sqlNoComments).not.toMatch(/CREATE POLICY.*ON users/i);
  });

  it('has a safety assertion checking users_self_select still exists', () => {
    expect(sql).toMatch(/users_self_select/);
    expect(sql).toMatch(/RAISE EXCEPTION/i);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('migration 035 — idempotency', () => {
  it('uses DROP POLICY IF EXISTS before every CREATE POLICY', () => {
    const createPolicies = sqlNoComments.match(/CREATE POLICY/gi) || [];
    const dropPolicies = sqlNoComments.match(/DROP POLICY IF EXISTS/gi) || [];
    expect(dropPolicies.length).toBe(createPolicies.length);
  });

  it('uses CREATE OR REPLACE for the helper function', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION owner_account_id/i);
  });
});

// ── Cross-account isolation design ───────────────────────────────────────────

describe('migration 035 — cross-account isolation (VAL-AUTH-022)', () => {
  it('all direct-account_id policies use owner_account_id() which resolves from auth.uid()', () => {
    // Every policy predicate must reference owner_account_id() or auth.uid()
    // This ensures cross-account isolation is enforced at the RLS level
    const policies = sql.match(/CREATE POLICY[\s\S]*?USING \([^)]+\)/gi) || [];
    for (const policy of policies) {
      expect(policy).toMatch(/owner_account_id\(\)|auth\.uid\(\)/i);
    }
  });

  it('all business_id JOIN policies filter through businesses.account_id = owner_account_id()', () => {
    const joinPolicies = sql.match(
      /business_id IN \(SELECT id FROM businesses WHERE account_id = owner_account_id\(\)\)/gi,
    ) || [];
    // Should have at least 13 (one per business-scoped table)
    expect(joinPolicies.length).toBeGreaterThanOrEqual(13);
  });

  it('no policy references a bare business_id without account_id verification', () => {
    // Ensure no policy grants access based on business_id alone
    // without verifying that business belongs to the user's account
    const policies = sql.match(/USING \([^)]+\)/gi) || [];
    for (const pred of policies) {
      if (pred.includes('business_id') && !pred.includes('account_id')) {
        // This is the SMS handle predicate which doesn't use business_id directly
        // but uses channel_enrollments.account_id - that's OK
        expect(pred).toMatch(/account_id|channel_enrollments/i);
      }
    }
  });
});

// ── Comprehensive table coverage ─────────────────────────────────────────────

describe('migration 035 — all protected tables have policies', () => {
  const tablesRequiringDirectPolicies = [
    'accounts',
    'businesses',
    'channel_enrollments',
    'api_costs',
    'notification_deliveries',
    'approval_audit_log',
    'account_audit_log',
  ];

  const tablesRequiringJoinPolicies = [
    'reviews',
    'responses',
    'approval_links',
    'weekly_summaries',
    'review_exceptions',
    'ranking_snapshots',
    'monthly_impact_emails',
    'onboarding_drip_log',
    'satisfaction_responses',
    'api_costs_daily_rollups',
    'zernio_connections',
    'zernio_finalize_incidents',
    'zernio_backfill_runs',
  ];

  const tablesRequiringSmsPolicies = [
    'sms_sender_opt_outs',
    'sms_sender_opt_out_events',
  ];

  it.each(tablesRequiringDirectPolicies)(
    '%s has at least one owner policy using account_id predicate',
    (table) => {
      expect(sql).toMatch(
        new RegExp(`CREATE POLICY \\w+_owner_\\w+ ON ${table}`, 'i'),
      );
      // Verify the policy uses the account_id or owner_account_id() pattern
      const policyMatch = sql.match(
        new RegExp(
          `CREATE POLICY \\w+_owner_\\w+ ON ${table}[\\s\\S]*?(?=DROP POLICY|CREATE POLICY|--)`,
          'i',
        ),
      );
      expect(policyMatch).toBeTruthy();
      expect(policyMatch![0]).toMatch(
        /account_id = owner_account_id\(\)|id = owner_account_id\(\)/i,
      );
    },
  );

  it.each(tablesRequiringJoinPolicies)(
    '%s has SELECT policy with business_id JOIN predicate',
    (table) => {
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_owner_select ON ${table}\\s+FOR SELECT`,
          'i',
        ),
      );
    },
  );

  it.each(tablesRequiringSmsPolicies)(
    '%s has SELECT policy with handle bridge predicate',
    (table) => {
      expect(sql).toMatch(
        new RegExp(`CREATE POLICY \\w+_owner_select ON ${table}`, 'i'),
      );
    },
  );

  it('total policy count matches expected (22 tables × policies)', () => {
    const createPolicies = sqlNoComments.match(/CREATE POLICY/gi) || [];
    // accounts:1, businesses:2, channel_enrollments:3, api_costs:1,
    // notification_deliveries:1, approval_audit_log:1, account_audit_log:1 = 10
    // 13 business-scoped: 13 × 1 = 13
    // 2 SMS tables: 2 × 1 = 2
    // Total = 25
    expect(createPolicies.length).toBe(25);
  });
});

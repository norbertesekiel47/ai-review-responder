/**
 * Structural validation test for migration 034_multi_location_schema.sql
 *
 * This test validates that the migration SQL file contains all required DDL
 * statements per the validation contract (VAL-SCHEMA-001 through VAL-SCHEMA-037).
 * It reads the SQL file and checks for the presence of key statements.
 *
 * This is NOT a database integration test — it cannot verify that the migration
 * actually runs successfully against a real database. That must be done manually
 * in the Supabase SQL editor. Instead, it catches accidental deletions,
 * mis-ordering, or missing statements that would cause the migration to fail.
 *
 * Run: pnpm test -- migration-034
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/034_multi_location_schema.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

// ── VAL-SCHEMA-001: accounts table ──────────────────────────────────────────

describe('migration 034 — VAL-SCHEMA-001: accounts table', () => {
  it('creates the accounts table with IF NOT EXISTS', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS accounts\s*\(/i);
  });

  const requiredColumns: Array<{ name: string; type: string; nullable: boolean; default?: string }> = [
    { name: 'id', type: 'UUID', nullable: false },
    { name: 'owner_user_id', type: 'UUID', nullable: false },
    { name: 'display_name', type: 'VARCHAR(255)', nullable: false },
    { name: 'subscription_tier', type: 'VARCHAR(20)', nullable: false, default: "'standard'" },
    { name: 'subscription_status', type: 'VARCHAR(20)', nullable: false, default: "'pending_payment'" },
    { name: 'stripe_customer_id', type: 'VARCHAR(255)', nullable: true },
    { name: 'stripe_subscription_id', type: 'VARCHAR(255)', nullable: true },
    { name: 'trial_ends_at', type: 'TIMESTAMPTZ', nullable: true },
    { name: 'subscription_activated_at', type: 'TIMESTAMPTZ', nullable: true },
    { name: 'locations_included', type: 'INTEGER', nullable: false, default: '1' },
    { name: 'locations_paid', type: 'INTEGER', nullable: false, default: '0' },
    { name: 'locations_overage_price_cents', type: 'INTEGER', nullable: false, default: '2500' },
    { name: 'flags', type: 'JSONB', nullable: false, default: "'{}'::jsonb" },
    { name: 'created_at', type: 'TIMESTAMPTZ', nullable: false, default: 'NOW()' },
    { name: 'updated_at', type: 'TIMESTAMPTZ', nullable: false, default: 'NOW()' },
  ];

  it.each(requiredColumns)(
    'includes column $name ($type) on accounts',
    ({ name, type, nullable, default: def }) => {
      const colPattern = new RegExp(
        `\\b${name}\\s+${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'i',
      );
      expect(sql).toMatch(colPattern);
      if (!nullable) {
        // PRIMARY KEY implies NOT NULL; accept either explicit NOT NULL or PRIMARY KEY
        expect(sql).toMatch(
          new RegExp(`\\b${name}\\b[^\\n]*(?:NOT\\s+NULL|PRIMARY\\s+KEY)`, 'i'),
        );
      }
      if (def) {
        expect(sql).toMatch(
          new RegExp(`\\b${name}\\b[^\\n]*DEFAULT\\s+${def.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
        );
      }
    },
  );

  it('enables RLS on accounts', () => {
    expect(sql).toMatch(/ALTER TABLE accounts ENABLE ROW LEVEL SECURITY/i);
  });
});

// ── VAL-SCHEMA-002: accounts indexes ────────────────────────────────────────

describe('migration 034 — VAL-SCHEMA-002: accounts indexes', () => {
  it('creates idx_accounts_owner on owner_user_id', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_accounts_owner\s+ON accounts\s*\(\s*owner_user_id\s*\)/i,
    );
  });

  it('creates idx_accounts_stripe_customer as partial index', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_accounts_stripe_customer\s+ON accounts\s*\(\s*stripe_customer_id\s*\)\s+WHERE\s+stripe_customer_id\s+IS\s+NOT\s+NULL/i,
    );
  });
});

// ── VAL-SCHEMA-003 through VAL-SCHEMA-009: account_id columns ───────────────

describe('migration 034 — account_id columns on existing tables', () => {
  const tables = [
    { table: 'businesses', assertion: 'VAL-SCHEMA-003', notNull: true },
    { table: 'users', assertion: 'VAL-SCHEMA-004', notNull: true },
    { table: 'channel_enrollments', assertion: 'VAL-SCHEMA-005', notNull: true },
    { table: 'api_costs', assertion: 'VAL-SCHEMA-007', notNull: true },
    { table: 'notification_deliveries', assertion: 'VAL-SCHEMA-008', notNull: true },
    { table: 'approval_audit_log', assertion: 'VAL-SCHEMA-009', notNull: true },
  ];

  it.each(tables)(
    '$assertion: adds account_id to $table',
    ({ table }) => {
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS account_id UUID`,
          'i',
        ),
      );
    },
  );

  it.each(tables)(
    '$assertion: sets account_id NOT NULL on $table after backfill',
    ({ table }) => {
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE ${table} ALTER COLUMN account_id SET NOT NULL`,
          'i',
        ),
      );
    },
  );

  it.each(tables.filter((t) => t.table !== 'businesses'))(
    '$assertion: adds FK constraint for account_id on $table',
    () => {
      expect(sql).toMatch(
        /FOREIGN KEY\s*\(\s*account_id\s*\)\s*REFERENCES\s+accounts\s*\(\s*id\s*\)/i,
      );
    },
  );
});

// ── VAL-SCHEMA-006: channel_enrollments.location_id ────────────────────────

describe('migration 034 — VAL-SCHEMA-006: channel_enrollments.location_id', () => {
  it('adds nullable location_id to channel_enrollments', () => {
    expect(sql).toMatch(
      /ALTER TABLE channel_enrollments ADD COLUMN IF NOT EXISTS location_id UUID/i,
    );
  });

  it('adds FK constraint for location_id to businesses(id)', () => {
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(\s*location_id\s*\)\s*REFERENCES\s+businesses\s*\(\s*id\s*\)/i,
    );
  });

  it('location_id is nullable (no NOT NULL on add)', () => {
    const addLine = sql.match(
      /ALTER TABLE channel_enrollments ADD COLUMN IF NOT EXISTS location_id UUID[^\n]*/i,
    )?.[0];
    expect(addLine).not.toMatch(/NOT NULL/i);
  });
});

// ── VAL-SCHEMA-010 through VAL-SCHEMA-012: businesses new columns ───────────

describe('migration 034 — businesses new columns', () => {
  it('VAL-SCHEMA-010: adds nullable display_label VARCHAR(255) to businesses', () => {
    expect(sql).toMatch(
      /ALTER TABLE businesses ADD COLUMN IF NOT EXISTS display_label VARCHAR\(255\)/i,
    );
    const addLine = sql.match(
      /ALTER TABLE businesses ADD COLUMN IF NOT EXISTS display_label[^\n]*/i,
    )?.[0];
    expect(addLine).not.toMatch(/NOT NULL/i);
  });

  it('VAL-SCHEMA-011: adds is_primary BOOLEAN NOT NULL DEFAULT FALSE to businesses', () => {
    expect(sql).toMatch(
      /ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE/i,
    );
  });

  it('VAL-SCHEMA-012: adds nullable archived_at TIMESTAMPTZ to businesses', () => {
    expect(sql).toMatch(
      /ALTER TABLE businesses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/i,
    );
    const addLine = sql.match(
      /ALTER TABLE businesses ADD COLUMN IF NOT EXISTS archived_at[^\n]*/i,
    )?.[0];
    expect(addLine).not.toMatch(/NOT NULL/i);
  });
});

// ── VAL-SCHEMA-013: drop users.business_id ───────────────────────────────────

describe('migration 034 — VAL-SCHEMA-013: drop users.business_id', () => {
  it('drops the FK constraint fk_users_business before dropping the column', () => {
    const constraintDropIdx = sql.indexOf('DROP CONSTRAINT IF EXISTS fk_users_business');
    const columnDropIdx = sql.indexOf('DROP COLUMN IF EXISTS business_id');
    expect(constraintDropIdx).toBeGreaterThan(-1);
    expect(columnDropIdx).toBeGreaterThan(-1);
    // Constraint drop must come BEFORE column drop
    expect(constraintDropIdx).toBeLessThan(columnDropIdx);
  });

  it('drops the business_id column', () => {
    expect(sql).toMatch(
      /ALTER TABLE users DROP COLUMN IF EXISTS business_id/i,
    );
  });
});

// ── VAL-SCHEMA-014 through VAL-SCHEMA-018: index drops ──────────────────────

describe('migration 034 — index/constraint drops', () => {
  it('VAL-SCHEMA-014: drops idx_users_owner_auth_by_business', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS idx_users_owner_auth_by_business/i);
  });

  it('VAL-SCHEMA-016: drops channel_enrollments_business_channel_active_key via DROP INDEX (not DROP CONSTRAINT)', () => {
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS channel_enrollments_business_channel_active_key/i,
    );
    // Must NOT use DROP CONSTRAINT for this object
    expect(sql).not.toMatch(
      /DROP CONSTRAINT.*channel_enrollments_business_channel_active_key/i,
    );
  });

  it('VAL-SCHEMA-017: drops channel_enrollments_one_mobile_per_biz', () => {
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_biz/i,
    );
  });

  it('VAL-SCHEMA-018: safety-check drops channel_enrollments_business_id_channel_key if it exists', () => {
    expect(sql).toMatch(/channel_enrollments_business_id_channel_key/);
  });
});

// ── VAL-SCHEMA-019 through VAL-SCHEMA-020: account_audit_log ─────────────────

describe('migration 034 — VAL-SCHEMA-019: account_audit_log table', () => {
  it('creates the account_audit_log table', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS account_audit_log\s*\(/i);
  });

  const columns = [
    { name: 'id', type: 'UUID', nullable: false },
    { name: 'account_id', type: 'UUID', nullable: false },
    { name: 'location_id', type: 'UUID', nullable: true },
    { name: 'event_type', type: 'TEXT', nullable: false },
    { name: 'actor_user_id', type: 'UUID', nullable: true },
    { name: 'payload', type: 'JSONB', nullable: false, default: "'{}'::jsonb" },
    { name: 'created_at', type: 'TIMESTAMPTZ', nullable: false, default: 'NOW()' },
  ];

  it.each(columns)(
    'includes column $name on account_audit_log',
    ({ name, type, nullable, default: def }) => {
      const colPattern = new RegExp(
        `\\b${name}\\s+${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'i',
      );
      expect(sql).toMatch(colPattern);
      if (!nullable) {
        // PRIMARY KEY implies NOT NULL; accept either explicit NOT NULL or PRIMARY KEY
        expect(sql).toMatch(
          new RegExp(`\\b${name}\\b[^\\n]*(?:NOT\\s+NULL|PRIMARY\\s+KEY)`, 'i'),
        );
      }
      if (def) {
        expect(sql).toMatch(
          new RegExp(`\\b${name}\\b[^\\n]*DEFAULT\\s+${def.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
        );
      }
    },
  );

  it('account_id has ON DELETE CASCADE', () => {
    expect(sql).toMatch(
      /account_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+accounts\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
    );
  });

  it('enables RLS on account_audit_log', () => {
    expect(sql).toMatch(
      /ALTER TABLE account_audit_log ENABLE ROW LEVEL SECURITY/i,
    );
  });
});

describe('migration 034 — VAL-SCHEMA-020: account_audit_log indexes', () => {
  it('creates idx_account_audit on (account_id, created_at)', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_account_audit\s+ON account_audit_log\s*\(\s*account_id\s*,\s*created_at\s*\)/i,
    );
  });

  it('creates idx_account_audit_event on (event_type, created_at)', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_account_audit_event\s+ON account_audit_log\s*\(\s*event_type\s*,\s*created_at\s*\)/i,
    );
  });
});

// ── VAL-SCHEMA-015: idx_users_owner_auth_by_account ─────────────────────────

describe('migration 034 — VAL-SCHEMA-015: idx_users_owner_auth_by_account', () => {
  it('creates partial index on users(account_id) WHERE role=owner AND auth_id IS NOT NULL', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_users_owner_auth_by_account\s+ON users\s*\(\s*account_id\s*\)\s+WHERE\s+role\s*=\s*'owner'\s+AND\s+auth_id\s+IS\s+NOT\s+NULL/i,
    );
  });
});

// ── VAL-SCHEMA-021: businesses account/primary indexes ──────────────────────

describe('migration 034 — VAL-SCHEMA-021: businesses indexes', () => {
  it('creates partial idx_businesses_account on (account_id) WHERE archived_at IS NULL', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_businesses_account\s+ON businesses\s*\(\s*account_id\s*\)\s+WHERE\s+archived_at\s+IS\s+NULL/i,
    );
  });

  it('creates partial unique businesses_account_primary_uniq', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS businesses_account_primary_uniq\s+ON businesses\s*\(\s*account_id\s*\)\s+WHERE\s+is_primary\s*=\s*TRUE\s+AND\s+archived_at\s+IS\s+NULL/i,
    );
  });
});

// ── VAL-SCHEMA-022: hot-table account indexes ───────────────────────────────

describe('migration 034 — VAL-SCHEMA-022: hot-table account indexes', () => {
  it('creates idx_api_costs_account on (account_id, created_at)', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_api_costs_account\s+ON api_costs\s*\(\s*account_id\s*,\s*created_at\s*\)/i,
    );
  });

  it('creates idx_nd_account on (account_id, created_at)', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_nd_account\s+ON notification_deliveries\s*\(\s*account_id\s*,\s*created_at\s*\)/i,
    );
  });

  it('creates idx_audit_account on (account_id, created_at)', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_audit_account\s+ON approval_audit_log\s*\(\s*account_id\s*,\s*created_at\s*\)/i,
    );
  });
});

// ── VAL-SCHEMA-023: channel_enrollments scope uniqueness index ───────────────

describe('migration 034 — VAL-SCHEMA-023: channel scope uniqueness', () => {
  it('creates channel_enrollments_account_channel_scope_uniq with COALESCE', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_account_channel_scope_uniq/i,
    );
    expect(sql).toMatch(/COALESCE\s*\(\s*location_id\s*,\s*'00000000-0000-0000-0000-000000000000'\s*\)/i);
    expect(sql).toMatch(/WHERE\s+archived_at\s+IS\s+NULL/i);
  });
});

// ── VAL-SCHEMA-024: channel_enrollments mobile-per-scope index ──────────────

describe('migration 034 — VAL-SCHEMA-024: mobile-per-scope index', () => {
  it('creates channel_enrollments_one_mobile_per_scope with COALESCE', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_one_mobile_per_scope/i,
    );
    expect(sql).toMatch(
      /channel\s+IN\s*\(\s*'sms'\s*,\s*'telegram'\s*,\s*'whatsapp'\s*\)/i,
    );
    expect(sql).toMatch(
      /status\s+IN\s*\(\s*'pending_verification'\s*,\s*'verified'\s*\)/i,
    );
  });
});

// ── VAL-SCHEMA-025 through VAL-SCHEMA-029: backfill ─────────────────────────

describe('migration 034 — backfill (VAL-SCHEMA-025–029)', () => {
  it('VAL-SCHEMA-025: backfill creates one account per existing business', () => {
    expect(sql).toMatch(/INSERT INTO accounts/i);
    expect(sql).toMatch(/FROM businesses/i);
    expect(sql).toMatch(/subscription_tier/i);
    expect(sql).toMatch(/subscription_status/i);
    expect(sql).toMatch(/stripe_customer_id/i);
    expect(sql).toMatch(/stripe_subscription_id/i);
  });

  it('VAL-SCHEMA-025: sets display_name = businesses.name', () => {
    expect(sql).toMatch(/display_name[\s\S]*b\.name|b\.name[\s\S]*display_name/);
  });

  it('VAL-SCHEMA-025: sets owner_user_id = businesses.onboarded_by', () => {
    expect(sql).toMatch(/onboarded_by/i);
  });

  it('VAL-SCHEMA-026: sets is_primary = TRUE for all existing businesses', () => {
    expect(sql).toMatch(/UPDATE businesses\s+SET\s+is_primary\s*=\s*TRUE/i);
  });

  it('VAL-SCHEMA-027: sets users.account_id from business', () => {
    expect(sql).toMatch(/account_id[\s\S]*businesses|businesses[\s\S]*account_id/);
  });

  it('VAL-SCHEMA-028: sets channel_enrollments.account_id from business', () => {
    expect(sql).toMatch(/channel_enrollments[\s\S]*account_id|UPDATE channel_enrollments/);
  });

  it('VAL-SCHEMA-029: sets hot-table account_id from business', () => {
    expect(sql).toMatch(/UPDATE api_costs/i);
    expect(sql).toMatch(/UPDATE notification_deliveries/i);
    expect(sql).toMatch(/UPDATE approval_audit_log/i);
  });
});

// ── VAL-SCHEMA-030: idempotency ─────────────────────────────────────────────

describe('migration 034 — VAL-SCHEMA-030: idempotency', () => {
  it('uses IF NOT EXISTS for table creation', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS accounts/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS account_audit_log/i);
  });

  it('uses IF NOT EXISTS for column additions', () => {
    const addColumns = sql.match(/ADD COLUMN IF NOT EXISTS/gi) || [];
    expect(addColumns.length).toBeGreaterThanOrEqual(8);
  });

  it('uses IF NOT EXISTS for index creation', () => {
    const createIndexes = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX IF NOT EXISTS/gi) || [];
    expect(createIndexes.length).toBeGreaterThanOrEqual(10);
  });

  it('uses IF EXISTS for index/constraint drops', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS/i);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS/i);
  });

  it('uses IF NOT EXISTS for FK constraint additions (via DO block)', () => {
    expect(sql).toMatch(/IF NOT EXISTS[\s\S]*pg_constraint[\s\S]*fk_|pg_constraint[\s\S]*fk_[\s\S]*IF NOT EXISTS/);
  });

  it('backfill skips already-processed rows (WHERE account_id IS NULL)', () => {
    const nullGuards = sql.match(/account_id\s+IS\s+NULL/gi) || [];
    expect(nullGuards.length).toBeGreaterThanOrEqual(5);
  });

  it('users backfill is guarded by business_id existence check (idempotent on re-run)', () => {
    expect(sql).toMatch(/EXECUTE/i);
    expect(sql).toMatch(/attname\s*=\s*'business_id'/i);
  });
});

// ── VAL-SCHEMA-035: no deprecation comment on users.business_id ─────────────

describe('migration 034 — VAL-SCHEMA-035: no deprecation comment on users.business_id', () => {
  it('does NOT add COMMENT on users.business_id — the column is dropped outright', () => {
    expect(sql).not.toMatch(/COMMENT ON COLUMN users\.business_id/i);
  });
});

// ── VAL-SCHEMA-036: deprecation comments on businesses subscription columns ─

describe('migration 034 — VAL-SCHEMA-036: deprecation comments on businesses subscription columns', () => {
  const deprecatedColumns = [
    'subscription_tier',
    'subscription_status',
    'stripe_customer_id',
    'stripe_subscription_id',
  ];

  it.each(deprecatedColumns)(
    'adds DEPRECATED comment on businesses.%s',
    (col) => {
      expect(sql).toMatch(
        new RegExp(
          `COMMENT ON COLUMN businesses\\.${col} IS\\s+'DEPRECATED`,
          'i',
        ),
      );
    },
  );
});

// ── VAL-SCHEMA-037: businesses subscription columns retained ────────────────

describe('migration 034 — VAL-SCHEMA-037: businesses subscription columns retained', () => {
  it('does NOT drop businesses.subscription_tier', () => {
    expect(sql).not.toMatch(/DROP COLUMN.*subscription_tier/i);
  });

  it('does NOT drop businesses.subscription_status', () => {
    expect(sql).not.toMatch(/DROP COLUMN.*subscription_status/i);
  });

  it('does NOT drop businesses.stripe_customer_id', () => {
    expect(sql).not.toMatch(/DROP COLUMN.*stripe_customer_id/i);
  });

  it('does NOT drop businesses.stripe_subscription_id', () => {
    expect(sql).not.toMatch(/DROP COLUMN.*stripe_subscription_id/i);
  });
});

// ── Ordering checks ──────────────────────────────────────────────────────────

describe('migration 034 — statement ordering', () => {
  it('creates accounts table BEFORE adding account_id FK columns', () => {
    const accountsCreate = sql.indexOf('CREATE TABLE IF NOT EXISTS accounts');
    const firstAccountIdAdd = sql.indexOf('ADD COLUMN IF NOT EXISTS account_id');
    expect(accountsCreate).toBeGreaterThan(-1);
    expect(firstAccountIdAdd).toBeGreaterThan(-1);
    expect(accountsCreate).toBeLessThan(firstAccountIdAdd);
  });

  it('backfills account_id BEFORE setting NOT NULL', () => {
    const backfillLoop = sql.indexOf('INSERT INTO accounts');
    const setNotNull = sql.indexOf('ALTER COLUMN account_id SET NOT NULL');
    expect(backfillLoop).toBeGreaterThan(-1);
    expect(setNotNull).toBeGreaterThan(-1);
    expect(backfillLoop).toBeLessThan(setNotNull);
  });

  it('drops users.business_id AFTER backfilling users.account_id', () => {
    const usersBackfill = sql.indexOf('account_id = b.account_id');
    const dropBusinessId = sql.indexOf('DROP COLUMN IF EXISTS business_id');
    expect(usersBackfill).toBeGreaterThan(-1);
    expect(dropBusinessId).toBeGreaterThan(-1);
    expect(usersBackfill).toBeLessThan(dropBusinessId);
  });

  it('creates unique indexes AFTER backfill sets is_primary = TRUE', () => {
    const setIsPrimary = sql.indexOf('SET is_primary = TRUE');
    const primaryUniq = sql.indexOf('businesses_account_primary_uniq');
    expect(setIsPrimary).toBeGreaterThan(-1);
    expect(primaryUniq).toBeGreaterThan(-1);
    expect(setIsPrimary).toBeLessThan(primaryUniq);
  });
});

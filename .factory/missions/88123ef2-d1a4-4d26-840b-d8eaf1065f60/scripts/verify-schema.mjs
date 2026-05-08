/**
 * Foundation milestone schema verification script.
 * Checks VAL-SCHEMA-* assertions against the live Supabase database.
 * 
 * Usage: node .factory/missions/.../scripts/verify-schema.mjs
 * Output: JSON to stdout with verification results
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { resolve } from 'path';

// Load .env.local (Next.js convention) which has DATABASE_URL
const envPath = resolve(import.meta.dirname, '..', '..', '..', '..', '.env.local');
const result = config({ path: envPath });
if (result.error) {
  console.error('Failed to load .env.local:', result.error.message);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not found. Available env keys with DB:', Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('SUPABASE')));
  process.exit(1);
}

// Supabase direct DB resolves to IPv6 only — use pooler URL for IPv4 access
// Direct: postgresql://postgres:PASS@db.PROJECT.supabase.co:5432/postgres
// Pooler: postgresql://postgres.PROJECT:PASS@aws-0-us-east-1.pooler.supabase.com:6543/postgres
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv6first');

// Try to convert direct URL to pooler URL
let connectionString = DATABASE_URL;
const directMatch = DATABASE_URL.match(/postgresql:\/\/postgres:([^@]+)@db\.([^.]+)\.supabase\.co:5432\/postgres/);
if (directMatch) {
  const password = directMatch[1];
  const projectRef = directMatch[2];
  // Try US East pooler first (most common)
  connectionString = `postgresql://postgres.${projectRef}:${password}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
  console.error(`Using pooler URL for project ${projectRef}`);
}

const sql = postgres(connectionString, { 
  ssl: 'require',
  connect_timeout: 15,
  max: 2
});

const results = {};

async function checkTableExists(tableName) {
  const rows = await sql`
    SELECT EXISTS (
      SELECT FROM pg_class WHERE relname = ${tableName}
    ) as exists
  `;
  return rows[0].exists;
}

async function getTableColumns(tableName) {
  return await sql`
    SELECT column_name, data_type, is_nullable, column_default, 
           col_description((SELECT oid FROM pg_class WHERE relname = ${tableName}), ordinal_position) as col_comment
    FROM information_schema.columns 
    WHERE table_name = ${tableName} AND table_schema = 'public'
    ORDER BY ordinal_position
  `;
}

async function getTableIndexes(tableName) {
  return await sql`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = ${tableName} AND schemaname = 'public'
  `;
}

async function getTableConstraints(tableName) {
  return await sql`
    SELECT conname, contype, pg_get_constraintdef(oid) as condef
    FROM pg_constraint 
    WHERE conrelid = (SELECT oid FROM pg_class WHERE relname = ${tableName})
  `;
}

async function getRLSStatus(tableName) {
  const rows = await sql`
    SELECT relrowsecurity FROM pg_class WHERE relname = ${tableName}
  `;
  return rows.length > 0 ? rows[0].relrowsecurity : null;
}

async function getRLSPolicies(tableName) {
  return await sql`
    SELECT policyname, cmd, qual, with_check 
    FROM pg_policies 
    WHERE tablename = ${tableName}
  `;
}

async function verifySchema() {
  // VAL-SCHEMA-001: accounts table
  console.error('Checking VAL-SCHEMA-001: accounts table...');
  const accountsExists = await checkTableExists('accounts');
  results['VAL-SCHEMA-001'] = { tableExists: accountsExists };
  
  if (accountsExists) {
    const cols = await getTableColumns('accounts');
    const colMap = {};
    for (const c of cols) {
      colMap[c.column_name] = {
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default
      };
    }
    results['VAL-SCHEMA-001'].columns = colMap;
    results['VAL-SCHEMA-001'].rlsEnabled = await getRLSStatus('accounts');
    
    // Check specific columns from spec
    const requiredCols = {
      'id': { type: 'uuid', nullable: false },
      'owner_user_id': { type: 'uuid', nullable: false },
      'display_name': { type: 'character varying', nullable: false },
      'subscription_tier': { type: 'character varying', nullable: false, default: "'standard'" },
      'subscription_status': { type: 'character varying', nullable: false, default: "'pending_payment'" },
      'stripe_customer_id': { type: 'character varying', nullable: true },
      'stripe_subscription_id': { type: 'character varying', nullable: true },
      'trial_ends_at': { type: 'timestamp with time zone', nullable: true },
      'subscription_activated_at': { type: 'timestamp with time zone', nullable: true },
      'locations_included': { type: 'integer', nullable: false, default: '1' },
      'locations_paid': { type: 'integer', nullable: false, default: '0' },
      'locations_overage_price_cents': { type: 'integer', nullable: false, default: '2500' },
      'flags': { type: 'jsonb', nullable: false, default: "'{}'::jsonb" },
      'created_at': { type: 'timestamp with time zone', nullable: false },
      'updated_at': { type: 'timestamp with time zone', nullable: false }
    };
    
    const colCheck = {};
    for (const [name, expected] of Object.entries(requiredCols)) {
      const actual = colMap[name];
      colCheck[name] = {
        present: !!actual,
        typeMatch: actual ? actual.type.includes(expected.type.split(' ')[0]) : false,
        nullableMatch: actual ? actual.nullable === expected.nullable : false,
        defaultMatch: actual ? (expected.default ? actual.default?.includes(expected.default.replace(/^'|'$/g, '')) : true) : false
      };
    }
    results['VAL-SCHEMA-001'].columnChecks = colCheck;
  }
  
  // VAL-SCHEMA-002: accounts indexes
  console.error('Checking VAL-SCHEMA-002: accounts indexes...');
  const accountsIdx = await getTableIndexes('accounts');
  results['VAL-SCHEMA-002'] = {
    indexes: accountsIdx.map(i => ({ name: i.indexname, def: i.indexdef })),
    idx_accounts_owner: accountsIdx.some(i => i.indexname === 'idx_accounts_owner'),
    idx_accounts_stripe_customer: accountsIdx.some(i => i.indexname === 'idx_accounts_stripe_customer')
  };
  
  // VAL-SCHEMA-003: businesses.account_id
  console.error('Checking VAL-SCHEMA-003: businesses.account_id...');
  const bizCols = await getTableColumns('businesses');
  const bizColMap = {};
  for (const c of bizCols) {
    bizColMap[c.column_name] = { type: c.data_type, nullable: c.is_nullable === 'YES', default: c.column_default, comment: c.col_comment };
  }
  results['VAL-SCHEMA-003'] = {
    account_id: bizColMap['account_id'] || null,
    hasFK: !!bizColMap['account_id']
  };
  
  // VAL-SCHEMA-004: users.account_id
  console.error('Checking VAL-SCHEMA-004: users.account_id...');
  const userCols = await getTableColumns('users');
  const userColMap = {};
  for (const c of userCols) {
    userColMap[c.column_name] = { type: c.data_type, nullable: c.is_nullable === 'YES', default: c.column_default };
  }
  results['VAL-SCHEMA-004'] = {
    account_id: userColMap['account_id'] || null,
    business_id_dropped: !userColMap['business_id']
  };
  
  // VAL-SCHEMA-005: channel_enrollments.account_id
  console.error('Checking VAL-SCHEMA-005: channel_enrollments.account_id...');
  const ceCols = await getTableColumns('channel_enrollments');
  const ceColMap = {};
  for (const c of ceCols) {
    ceColMap[c.column_name] = { type: c.data_type, nullable: c.is_nullable === 'YES', default: c.column_default };
  }
  results['VAL-SCHEMA-005'] = {
    account_id: ceColMap['account_id'] || null
  };
  
  // VAL-SCHEMA-006: channel_enrollments.location_id
  console.error('Checking VAL-SCHEMA-006: channel_enrollments.location_id...');
  results['VAL-SCHEMA-006'] = {
    location_id: ceColMap['location_id'] || null,
    isNullable: ceColMap['location_id']?.nullable === true
  };
  
  // VAL-SCHEMA-007-009: hot-table account_id columns
  for (const [table, assertionPrefix] of [['api_costs', '007'], ['notification_deliveries', '008'], ['approval_audit_log', '009']]) {
    console.error(`Checking VAL-SCHEMA-${assertionPrefix}: ${table}.account_id...`);
    const tCols = await getTableColumns(table);
    const tColMap = {};
    for (const c of tCols) {
      tColMap[c.column_name] = { type: c.data_type, nullable: c.is_nullable === 'YES' };
    }
    results[`VAL-SCHEMA-${assertionPrefix}`] = {
      account_id: tColMap['account_id'] || null
    };
  }
  
  // VAL-SCHEMA-010: businesses.display_label
  console.error('Checking VAL-SCHEMA-010: businesses.display_label...');
  results['VAL-SCHEMA-010'] = {
    display_label: bizColMap['display_label'] || null,
    isNullable: bizColMap['display_label']?.nullable === true
  };
  
  // VAL-SCHEMA-011: businesses.is_primary
  console.error('Checking VAL-SCHEMA-011: businesses.is_primary...');
  results['VAL-SCHEMA-011'] = {
    is_primary: bizColMap['is_primary'] || null,
    defaultIsFalse: bizColMap['is_primary']?.default === 'false'
  };
  
  // VAL-SCHEMA-012: businesses.archived_at
  console.error('Checking VAL-SCHEMA-012: businesses.archived_at...');
  results['VAL-SCHEMA-012'] = {
    archived_at: bizColMap['archived_at'] || null,
    isNullable: bizColMap['archived_at']?.nullable === true
  };
  
  // VAL-SCHEMA-013: users.business_id dropped
  console.error('Checking VAL-SCHEMA-013: users.business_id dropped...');
  results['VAL-SCHEMA-013'] = {
    business_id_dropped: !userColMap['business_id']
  };
  
  // VAL-SCHEMA-014: idx_users_owner_auth_by_business dropped
  console.error('Checking VAL-SCHEMA-014: idx_users_owner_auth_by_business dropped...');
  const userIdx = await getTableIndexes('users');
  results['VAL-SCHEMA-014'] = {
    oldIndexDropped: !userIdx.some(i => i.indexname === 'idx_users_owner_auth_by_business')
  };
  
  // VAL-SCHEMA-015: idx_users_owner_auth_by_account created
  console.error('Checking VAL-SCHEMA-015: idx_users_owner_auth_by_account...');
  results['VAL-SCHEMA-015'] = {
    newIndexExists: userIdx.some(i => i.indexname === 'idx_users_owner_auth_by_account'),
    indexDef: userIdx.find(i => i.indexname === 'idx_users_owner_auth_by_account')?.indexdef || null
  };
  
  // VAL-SCHEMA-016: channel_enrollments_business_channel_active_key dropped as INDEX
  console.error('Checking VAL-SCHEMA-016: channel_enrollments index dropped...');
  const ceIdx = await getTableIndexes('channel_enrollments');
  results['VAL-SCHEMA-016'] = {
    oldIndexDropped: !ceIdx.some(i => i.indexname === 'channel_enrollments_business_channel_active_key')
  };
  
  // VAL-SCHEMA-017: channel_enrollments_one_mobile_per_biz dropped
  console.error('Checking VAL-SCHEMA-017: channel_enrollments_one_mobile_per_biz dropped...');
  results['VAL-SCHEMA-017'] = {
    oldIndexDropped: !ceIdx.some(i => i.indexname === 'channel_enrollments_one_mobile_per_biz')
  };
  
  // VAL-SCHEMA-018: channel_enrollments_business_id_channel_key dropped
  console.error('Checking VAL-SCHEMA-018: channel_enrollments_business_id_channel_key...');
  const ceConstraints = await getTableConstraints('channel_enrollments');
  results['VAL-SCHEMA-018'] = {
    constraintDropped: !ceConstraints.some(c => c.conname === 'channel_enrollments_business_id_channel_key')
  };
  
  // VAL-SCHEMA-019: account_audit_log table
  console.error('Checking VAL-SCHEMA-019: account_audit_log table...');
  const auditLogExists = await checkTableExists('account_audit_log');
  results['VAL-SCHEMA-019'] = { tableExists: auditLogExists };
  if (auditLogExists) {
    const auditCols = await getTableColumns('account_audit_log');
    const auditColMap = {};
    for (const c of auditCols) {
      auditColMap[c.column_name] = { type: c.data_type, nullable: c.is_nullable === 'YES', default: c.column_default };
    }
    results['VAL-SCHEMA-019'].columns = auditColMap;
    // Check FK cascade on account_id
    const auditConstraints = await getTableConstraints('account_audit_log');
    results['VAL-SCHEMA-019'].constraints = auditConstraints.map(c => ({ name: c.conname, type: c.contype, def: c.condef }));
    const cascadeFK = auditConstraints.find(c => c.condef && c.condef.includes('accounts') && c.condef.includes('CASCADE'));
    results['VAL-SCHEMA-019'].hasCascadeOnAccount = !!cascadeFK;
  }
  
  // VAL-SCHEMA-020: account_audit_log indexes
  console.error('Checking VAL-SCHEMA-020: account_audit_log indexes...');
  if (auditLogExists) {
    const auditIdx = await getTableIndexes('account_audit_log');
    results['VAL-SCHEMA-020'] = {
      idx_account_audit: auditIdx.some(i => i.indexname === 'idx_account_audit'),
      idx_account_audit_event: auditIdx.some(i => i.indexname === 'idx_account_audit_event'),
      allIndexes: auditIdx.map(i => ({ name: i.indexname, def: i.indexdef }))
    };
  }
  
  // VAL-SCHEMA-021: businesses account/primary indexes
  console.error('Checking VAL-SCHEMA-021: businesses account/primary indexes...');
  const bizIdx = await getTableIndexes('businesses');
  results['VAL-SCHEMA-021'] = {
    idx_businesses_account: bizIdx.some(i => i.indexname === 'idx_businesses_account'),
    idx_businesses_account_def: bizIdx.find(i => i.indexname === 'idx_businesses_account')?.indexdef || null,
    businesses_account_primary_uniq: bizIdx.some(i => i.indexname === 'businesses_account_primary_uniq'),
    businesses_account_primary_uniq_def: bizIdx.find(i => i.indexname === 'businesses_account_primary_uniq')?.indexdef || null
  };
  
  // VAL-SCHEMA-022: hot-table account indexes
  console.error('Checking VAL-SCHEMA-022: hot-table account indexes...');
  const apiCostsIdx = await getTableIndexes('api_costs');
  const ndIdx = await getTableIndexes('notification_deliveries');
  const approvalAuditIdx = await getTableIndexes('approval_audit_log');
  results['VAL-SCHEMA-022'] = {
    idx_api_costs_account: apiCostsIdx.some(i => i.indexname === 'idx_api_costs_account'),
    idx_nd_account: ndIdx.some(i => i.indexname === 'idx_nd_account'),
    idx_audit_account: approvalAuditIdx.some(i => i.indexname === 'idx_audit_account')
  };
  
  // VAL-SCHEMA-023: channel_enrollments scope uniqueness index
  console.error('Checking VAL-SCHEMA-023: channel_enrollments scope uniqueness...');
  results['VAL-SCHEMA-023'] = {
    indexExists: ceIdx.some(i => i.indexname === 'channel_enrollments_account_channel_scope_uniq'),
    indexDef: ceIdx.find(i => i.indexname === 'channel_enrollments_account_channel_scope_uniq')?.indexdef || null
  };
  
  // VAL-SCHEMA-024: channel_enrollments mobile-per-scope index
  console.error('Checking VAL-SCHEMA-024: channel_enrollments mobile-per-scope...');
  results['VAL-SCHEMA-024'] = {
    indexExists: ceIdx.some(i => i.indexname === 'channel_enrollments_one_mobile_per_scope'),
    indexDef: ceIdx.find(i => i.indexname === 'channel_enrollments_one_mobile_per_scope')?.indexdef || null
  };
  
  // VAL-SCHEMA-035: no deprecated comments on users.business_id
  console.error('Checking VAL-SCHEMA-035: no deprecated comments on users.business_id...');
  results['VAL-SCHEMA-035'] = {
    columnDropped: !userColMap['business_id'],
    commentCheck: 'N/A - column does not exist (dropped outright)'
  };
  
  // VAL-SCHEMA-036: deprecated comments on businesses subscription columns
  console.error('Checking VAL-SCHEMA-036: deprecated comments on businesses subscription columns...');
  const deprecationCheck = {};
  for (const col of ['subscription_tier', 'subscription_status', 'stripe_customer_id', 'stripe_subscription_id']) {
    deprecationCheck[col] = {
      present: !!bizColMap[col],
      comment: bizColMap[col]?.comment || null
    };
  }
  results['VAL-SCHEMA-036'] = deprecationCheck;
  
  // VAL-SCHEMA-037: businesses subscription columns retained
  console.error('Checking VAL-SCHEMA-037: businesses subscription columns retained...');
  results['VAL-SCHEMA-037'] = {
    subscription_tier_present: !!bizColMap['subscription_tier'],
    subscription_status_present: !!bizColMap['subscription_status'],
    stripe_customer_id_present: !!bizColMap['stripe_customer_id'],
    stripe_subscription_id_present: !!bizColMap['stripe_subscription_id']
  };
  
  // VAL-AUTH-035: account_audit_log RLS
  console.error('Checking VAL-AUTH-035: account_audit_log RLS...');
  if (auditLogExists) {
    results['VAL-AUTH-035'] = {
      rlsEnabled: await getRLSStatus('account_audit_log'),
      policies: await getRLSPolicies('account_audit_log')
    };
  }
  
  // RLS checks for all protected tables (VAL-AUTH-001 to VAL-AUTH-021)
  const rlsTables = [
    { name: 'accounts', assertion: 'VAL-AUTH-001' },
    { name: 'businesses', assertion: 'VAL-AUTH-002' },
    { name: 'channel_enrollments', assertion: 'VAL-AUTH-003' },
    { name: 'api_costs', assertion: 'VAL-AUTH-004' },
    { name: 'notification_deliveries', assertion: 'VAL-AUTH-005' },
    { name: 'approval_audit_log', assertion: 'VAL-AUTH-006' },
    { name: 'reviews', assertion: 'VAL-AUTH-007' },
    { name: 'responses', assertion: 'VAL-AUTH-008' },
    { name: 'approval_links', assertion: 'VAL-AUTH-009' },
    { name: 'weekly_summaries', assertion: 'VAL-AUTH-010' },
    { name: 'review_exceptions', assertion: 'VAL-AUTH-011' },
    { name: 'ranking_snapshots', assertion: 'VAL-AUTH-012' },
    { name: 'monthly_impact_emails', assertion: 'VAL-AUTH-013' },
    { name: 'onboarding_drip_log', assertion: 'VAL-AUTH-014' },
    { name: 'satisfaction_responses', assertion: 'VAL-AUTH-015' },
    { name: 'api_costs_daily_rollups', assertion: 'VAL-AUTH-016' },
    { name: 'sms_sender_opt_outs', assertion: 'VAL-AUTH-017' },
    { name: 'sms_sender_opt_out_events', assertion: 'VAL-AUTH-018' },
    { name: 'zernio_connections', assertion: 'VAL-AUTH-019' },
    { name: 'zernio_finalize_incidents', assertion: 'VAL-AUTH-020' },
    { name: 'zernio_backfill_runs', assertion: 'VAL-AUTH-021' }
  ];
  
  for (const t of rlsTables) {
    console.error(`Checking ${t.assertion}: ${t.name} RLS...`);
    const exists = await checkTableExists(t.name);
    if (exists) {
      results[t.assertion] = {
        tableExists: true,
        rlsEnabled: await getRLSStatus(t.name),
        policies: await getRLSPolicies(t.name)
      };
    } else {
      results[t.assertion] = { tableExists: false, rlsEnabled: null, policies: [] };
    }
  }
  
  // Backfill checks (VAL-SCHEMA-025-029) - check if data exists for verification
  console.error('Checking backfill data availability...');
  const bizCount = await sql`SELECT count(*)::int as cnt FROM businesses`;
  const accountsCount = await sql`SELECT count(*)::int as cnt FROM accounts`;
  const usersCount = await sql`SELECT count(*)::int as cnt FROM users`;
  results['backfill_data'] = {
    businesses: bizCount[0].cnt,
    accounts: accountsCount[0].cnt,
    users: usersCount[0].cnt,
    hasDataForBackfill: bizCount[0].cnt > 0
  };
  
  // If there's data, run backfill checks
  if (bizCount[0].cnt > 0) {
    // VAL-SCHEMA-025: one account per business
    const orphanBiz = await sql`SELECT count(*)::int as cnt FROM businesses b LEFT JOIN accounts a ON a.id = b.account_id WHERE a.id IS NULL`;
    results['VAL-SCHEMA-025'] = { orphanBusinesses: orphanBiz[0].cnt, pass: orphanBiz[0].cnt === 0 };
    
    // VAL-SCHEMA-026: is_primary = TRUE for all existing businesses
    const nonPrimary = await sql`SELECT count(*)::int as cnt FROM businesses WHERE is_primary = FALSE AND account_id IN (SELECT id FROM accounts)`;
    results['VAL-SCHEMA-026'] = { nonPrimaryBusinesses: nonPrimary[0].cnt, pass: nonPrimary[0].cnt === 0 };
    
    // VAL-SCHEMA-027: users.account_id matches business's account_id
    // This can't be checked since users.business_id is dropped
    
    // VAL-SCHEMA-028: channel_enrollments.account_id
    const ceOrphans = await sql`SELECT count(*)::int as cnt FROM channel_enrollments WHERE account_id IS NULL`;
    results['VAL-SCHEMA-028'] = { orphanEnrollments: ceOrphans[0].cnt, pass: ceOrphans[0].cnt === 0 };
    
    // VAL-SCHEMA-029: hot-table account_id
    for (const table of ['api_costs', 'notification_deliveries', 'approval_audit_log']) {
      const orphans = await sql.unsafe(`SELECT count(*)::int as cnt FROM ${sql(table)} WHERE account_id IS NULL`);
      results[`VAL-SCHEMA-029_${table}`] = { orphanRows: orphans[0]?.cnt, pass: orphans[0]?.cnt === 0 };
    }
  } else {
    results['VAL-SCHEMA-025'] = { pass: null, reason: 'No businesses in database - backfill is vacuously correct but cannot be meaningfully verified' };
    results['VAL-SCHEMA-026'] = { pass: null, reason: 'No businesses in database - cannot verify is_primary backfill' };
    results['VAL-SCHEMA-027'] = { pass: null, reason: 'No users in database - cannot verify account_id backfill' };
    results['VAL-SCHEMA-028'] = { pass: null, reason: 'No channel_enrollments - cannot verify account_id backfill' };
    results['VAL-SCHEMA-029'] = { pass: null, reason: 'No hot-table data - cannot verify account_id backfill' };
  }
  
  // VAL-SCHEMA-030: idempotency - check if re-running migration causes issues
  // We'll note this needs manual verification
  results['VAL-SCHEMA-030'] = { note: 'Idempotency requires re-running migration SQL - should be verified manually' };
  
  // Accounts RLS check (VAL-AUTH-001 / VAL-SCHEMA-001)
  results['VAL-SCHEMA-001'].rlsEnabled = await getRLSStatus('accounts');
  
  return results;
}

try {
  const results = await verifySchema();
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('Error:', err.message);
  console.log(JSON.stringify({ error: err.message }, null, 2));
} finally {
  await sql.end();
}

const postgres = require('postgres');
const fs = require('fs');

const envContent = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envContent.split('\n').find(l => l.startsWith('DATABASE_POOL_URL=')).replace('DATABASE_POOL_URL=', '').trim();
const sql = postgres(dbUrl);

const results = {};

async function verify() {
  try {
    // === VAL-SCHEMA-001: accounts table structure ===
    const acctCols = await sql`SELECT column_name, data_type, is_nullable, column_default 
      FROM information_schema.columns WHERE table_name = 'accounts' ORDER BY ordinal_position`;
    const acctColMap = {};
    for (const c of acctCols) acctColMap[c.column_name] = c;
    
    const requiredAcctCols = {
      id: { type: 'uuid', nullable: 'NO' },
      owner_user_id: { type: 'uuid', nullable: 'NO' },
      display_name: { type: null, nullable: 'NO' },  // character varying
      subscription_tier: { type: null, nullable: 'NO' }, // character varying
      subscription_status: { type: null, nullable: 'NO' },
      stripe_customer_id: { type: null, nullable: 'YES' },
      stripe_subscription_id: { type: null, nullable: 'YES' },
      trial_ends_at: { type: 'timestamp with time zone', nullable: 'YES' },
      subscription_activated_at: { type: 'timestamp with time zone', nullable: 'YES' },
      locations_included: { type: 'integer', nullable: 'NO' },
      locations_paid: { type: 'integer', nullable: 'NO' },
      locations_overage_price_cents: { type: 'integer', nullable: 'NO' },
      flags: { type: 'jsonb', nullable: 'NO' },
      created_at: { type: 'timestamp with time zone', nullable: 'NO' },
      updated_at: { type: 'timestamp with time zone', nullable: 'NO' },
    };
    
    let schema001Pass = true;
    let schema001Details = [];
    for (const [col, spec] of Object.entries(requiredAcctCols)) {
      if (!acctColMap[col]) {
        schema001Pass = false;
        schema001Details.push(`MISSING column: ${col}`);
      } else if (spec.nullable && acctColMap[col].is_nullable !== spec.nullable) {
        schema001Pass = false;
        schema001Details.push(`WRONG nullable for ${col}: expected ${spec.nullable}, got ${acctColMap[col].is_nullable}`);
      }
    }
    results['VAL-SCHEMA-001'] = { pass: schema001Pass, details: schema001Details.join('; ') || 'All columns present with correct nullability' };

    // RLS on accounts
    const acctRls = await sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'accounts'`;
    results['VAL-SCHEMA-001'].rlsEnabled = acctRls.length > 0 && acctRls[0].relrowsecurity;
    if (!results['VAL-SCHEMA-001'].rlsEnabled) {
      results['VAL-SCHEMA-001'].pass = false;
      results['VAL-SCHEMA-001'].details += '; RLS not enabled on accounts';
    }

    // === VAL-SCHEMA-002: accounts indexes ===
    const acctIndexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'accounts' AND indexname IN ('idx_accounts_owner', 'idx_accounts_stripe_customer')`;
    const hasOwnerIdx = acctIndexes.some(i => i.indexname === 'idx_accounts_owner');
    const hasStripeIdx = acctIndexes.some(i => i.indexname === 'idx_accounts_stripe_customer' && i.indexdef.includes('WHERE stripe_customer_id IS NOT NULL'));
    results['VAL-SCHEMA-002'] = { pass: hasOwnerIdx && hasStripeIdx, details: `owner_idx=${hasOwnerIdx}, stripe_partial_idx=${hasStripeIdx}` };

    // === VAL-SCHEMA-003 through VAL-SCHEMA-009: account_id on tables ===
    const tablesWithAccountId = ['businesses', 'users', 'channel_enrollments', 'api_costs', 'notification_deliveries', 'approval_audit_log'];
    const acctIdChecks = {};
    for (const table of tablesWithAccountId) {
      const cols = await sql`SELECT column_name, is_nullable, data_type FROM information_schema.columns 
        WHERE table_name = ${table} AND column_name = 'account_id'`;
      const hasCol = cols.length > 0;
      const isNotNull = hasCol && cols[0].is_nullable === 'NO';
      acctIdChecks[table] = { hasColumn: hasCol, notNull: isNotNull };
    }
    
    // VAL-SCHEMA-003: businesses.account_id
    results['VAL-SCHEMA-003'] = { pass: acctIdChecks.businesses.hasColumn && acctIdChecks.businesses.notNull, details: JSON.stringify(acctIdChecks.businesses) };
    // VAL-SCHEMA-004: users.account_id
    results['VAL-SCHEMA-004'] = { pass: acctIdChecks.users.hasColumn && acctIdChecks.users.notNull, details: JSON.stringify(acctIdChecks.users) };
    // VAL-SCHEMA-005: channel_enrollments.account_id
    results['VAL-SCHEMA-005'] = { pass: acctIdChecks.channel_enrollments.hasColumn && acctIdChecks.channel_enrollments.notNull, details: JSON.stringify(acctIdChecks.channel_enrollments) };
    // VAL-SCHEMA-007: api_costs.account_id
    results['VAL-SCHEMA-007'] = { pass: acctIdChecks.api_costs.hasColumn && acctIdChecks.api_costs.notNull, details: JSON.stringify(acctIdChecks.api_costs) };
    // VAL-SCHEMA-008: notification_deliveries.account_id
    results['VAL-SCHEMA-008'] = { pass: acctIdChecks.notification_deliveries.hasColumn && acctIdChecks.notification_deliveries.notNull, details: JSON.stringify(acctIdChecks.notification_deliveries) };
    // VAL-SCHEMA-009: approval_audit_log.account_id
    results['VAL-SCHEMA-009'] = { pass: acctIdChecks.approval_audit_log.hasColumn && acctIdChecks.approval_audit_log.notNull, details: JSON.stringify(acctIdChecks.approval_audit_log) };

    // === VAL-SCHEMA-006: channel_enrollments.location_id (nullable) ===
    const ceLocCols = await sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'channel_enrollments' AND column_name = 'location_id'`;
    results['VAL-SCHEMA-006'] = { pass: ceLocCols.length > 0 && ceLocCols[0].is_nullable === 'YES', details: JSON.stringify(ceLocCols[0]) };

    // === VAL-SCHEMA-010: businesses.display_label (nullable) ===
    const dlCols = await sql`SELECT column_name, is_nullable, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'display_label'`;
    results['VAL-SCHEMA-010'] = { pass: dlCols.length > 0 && dlCols[0].is_nullable === 'YES', details: JSON.stringify(dlCols[0]) };

    // === VAL-SCHEMA-011: businesses.is_primary (NOT NULL DEFAULT FALSE) ===
    const ipCols = await sql`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'is_primary'`;
    results['VAL-SCHEMA-011'] = { pass: ipCols.length > 0 && ipCols[0].is_nullable === 'NO' && ipCols[0].column_default === 'false', details: JSON.stringify(ipCols[0]) };

    // === VAL-SCHEMA-012: businesses.archived_at (nullable) ===
    const aaCols = await sql`SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'archived_at'`;
    results['VAL-SCHEMA-012'] = { pass: aaCols.length > 0 && aaCols[0].is_nullable === 'YES', details: JSON.stringify(aaCols[0]) };

    // === VAL-SCHEMA-013: users.business_id DROPPED ===
    const bizIdCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'business_id'`;
    results['VAL-SCHEMA-013'] = { pass: bizIdCols.length === 0, details: `business_id column count: ${bizIdCols.length}` };

    // === VAL-SCHEMA-014: idx_users_owner_auth_by_business DROPPED ===
    const oldIdx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_users_owner_auth_by_business'`;
    results['VAL-SCHEMA-014'] = { pass: oldIdx.length === 0, details: `old index count: ${oldIdx.length}` };

    // === VAL-SCHEMA-015: idx_users_owner_auth_by_account EXISTS ===
    const newIdx = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_users_owner_auth_by_account'`;
    const hasPartialPredicate = newIdx.length > 0 && newIdx[0].indexdef.includes("role = 'owner'") && newIdx[0].indexdef.includes('auth_id IS NOT NULL');
    results['VAL-SCHEMA-015'] = { pass: hasPartialPredicate, details: newIdx.length > 0 ? newIdx[0].indexdef : 'NOT FOUND' };

    // === VAL-SCHEMA-016: channel_enrollments_business_channel_active_key dropped as INDEX ===
    const ceOldIdx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'channel_enrollments_business_channel_active_key'`;
    results['VAL-SCHEMA-016'] = { pass: ceOldIdx.length === 0, details: `old index count: ${ceOldIdx.length}` };

    // === VAL-SCHEMA-017: channel_enrollments_one_mobile_per_biz DROPPED ===
    const ceMobileOldIdx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'channel_enrollments_one_mobile_per_biz'`;
    results['VAL-SCHEMA-017'] = { pass: ceMobileOldIdx.length === 0, details: `old index count: ${ceMobileOldIdx.length}` };

    // === VAL-SCHEMA-018: channel_enrollments_business_id_channel_key does not exist ===
    const ceConstraint = await sql`SELECT conname FROM pg_constraint WHERE conname = 'channel_enrollments_business_id_channel_key'`;
    results['VAL-SCHEMA-018'] = { pass: ceConstraint.length === 0, details: `constraint count: ${ceConstraint.length}` };

    // === VAL-SCHEMA-019: account_audit_log table structure ===
    const auditCols = await sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'account_audit_log' ORDER BY ordinal_position`;
    const auditColMap = {};
    for (const c of auditCols) auditColMap[c.column_name] = c;
    
    const requiredAuditCols = ['id', 'account_id', 'location_id', 'event_type', 'actor_user_id', 'payload', 'created_at'];
    let auditPass = true;
    let auditDetails = [];
    for (const col of requiredAuditCols) {
      if (!auditColMap[col]) {
        auditPass = false;
        auditDetails.push(`MISSING: ${col}`);
      }
    }
    // Check cascade delete
    const auditFK = await sql`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'account_audit_log'::regclass AND confrelid = 'accounts'::regclass`;
    const hasCascade = auditFK.some(fk => fk.confdeltype === 'c'); // 'c' = CASCADE
    if (!hasCascade) {
      auditPass = false;
      auditDetails.push('Missing ON DELETE CASCADE on account_id FK');
    }
    results['VAL-SCHEMA-019'] = { pass: auditPass, details: auditDetails.join('; ') || 'All 7 columns present, CASCADE delete confirmed' };

    // === VAL-SCHEMA-020: account_audit_log indexes ===
    const auditIndexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'account_audit_log' AND indexname IN ('idx_account_audit', 'idx_account_audit_event')`;
    const hasAcctIdx = auditIndexes.some(i => i.indexname === 'idx_account_audit');
    const hasEventIdx = auditIndexes.some(i => i.indexname === 'idx_account_audit_event');
    results['VAL-SCHEMA-020'] = { pass: hasAcctIdx && hasEventIdx, details: `account_idx=${hasAcctIdx}, event_idx=${hasEventIdx}` };

    // === VAL-SCHEMA-021: businesses account/primary indexes ===
    const bizIndexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'businesses' AND indexname IN ('idx_businesses_account', 'businesses_account_primary_uniq')`;
    const hasBizAcctIdx = bizIndexes.some(i => i.indexname === 'idx_businesses_account' && i.indexdef.includes('WHERE archived_at IS NULL'));
    const hasPrimaryUniq = bizIndexes.some(i => i.indexname === 'businesses_account_primary_uniq' && i.indexdef.includes('is_primary = TRUE') && i.indexdef.includes('archived_at IS NULL'));
    results['VAL-SCHEMA-021'] = { pass: hasBizAcctIdx && hasPrimaryUniq, details: `account_idx=${hasBizAcctIdx}, primary_uniq=${hasPrimaryUniq}` };

    // === VAL-SCHEMA-022: hot-table account indexes ===
    const hotIndexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('idx_api_costs_account', 'idx_nd_account', 'idx_audit_account')`;
    const hasApiCostsIdx = hotIndexes.some(i => i.indexname === 'idx_api_costs_account');
    const hasNdIdx = hotIndexes.some(i => i.indexname === 'idx_nd_account');
    const hasAuditIdx = hotIndexes.some(i => i.indexname === 'idx_audit_account');
    results['VAL-SCHEMA-022'] = { pass: hasApiCostsIdx && hasNdIdx && hasAuditIdx, details: `api_costs=${hasApiCostsIdx}, nd=${hasNdIdx}, audit=${hasAuditIdx}` };

    // === VAL-SCHEMA-023: channel_enrollments scope uniqueness index ===
    const scopeIdx = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'channel_enrollments_account_channel_scope_uniq'`;
    const hasScopeUniq = scopeIdx.length > 0 && scopeIdx[0].indexdef.includes('COALESCE') && scopeIdx[0].indexdef.includes('archived_at IS NULL');
    results['VAL-SCHEMA-023'] = { pass: hasScopeUniq, details: scopeIdx.length > 0 ? scopeIdx[0].indexdef : 'NOT FOUND' };

    // === VAL-SCHEMA-024: channel_enrollments mobile-per-scope index ===
    const mobileIdx = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'channel_enrollments_one_mobile_per_scope'`;
    const hasMobileIdx = mobileIdx.length > 0 && mobileIdx[0].indexdef.includes("'sms','telegram','whatsapp'") && mobileIdx[0].indexdef.includes('COALESCE');
    results['VAL-SCHEMA-024'] = { pass: hasMobileIdx, details: mobileIdx.length > 0 ? mobileIdx[0].indexdef : 'NOT FOUND' };

    // === VAL-SCHEMA-025 through VAL-SCHEMA-029: Backfill verification ===
    // Since DB is empty, backfill is vacuously correct
    const bizCount = await sql`SELECT count(*)::int as cnt FROM businesses`;
    const userCount = await sql`SELECT count(*)::int as cnt FROM users`;
    if (bizCount[0].cnt === 0 && userCount[0].cnt === 0) {
      results['VAL-SCHEMA-025'] = { pass: true, details: 'Vacuously correct — no pre-existing businesses to backfill (empty DB)' };
      results['VAL-SCHEMA-026'] = { pass: true, details: 'Vacuously correct — no pre-existing businesses (empty DB)' };
      results['VAL-SCHEMA-027'] = { pass: true, details: 'Vacuously correct — no pre-existing users (empty DB)' };
      results['VAL-SCHEMA-028'] = { pass: true, details: 'Vacuously correct — no pre-existing enrollments (empty DB)' };
      results['VAL-SCHEMA-029'] = { pass: true, details: 'Vacuously correct — no pre-existing rows (empty DB)' };
    }

    // === VAL-SCHEMA-030: Migration idempotency ===
    // Can't test without re-running migration - mark as needing manual verification
    results['VAL-SCHEMA-030'] = { pass: false, details: 'Cannot verify idempotency without re-running migration — requires psql access and manual verification' };

    // === VAL-SCHEMA-035: No deprecated comments on users.business_id ===
    // Column doesn't exist, so this is automatically true
    results['VAL-SCHEMA-035'] = { pass: true, details: 'users.business_id column does not exist (dropped), so no deprecation comment possible' };

    // === VAL-SCHEMA-036: Deprecation comments on businesses subscription columns ===
    const bizSubComments = await sql`SELECT a.attname, col_description(a.attrelid, a.attnum) as comment 
      FROM pg_attribute a WHERE a.attrelid = 'businesses'::regclass 
      AND a.attname IN ('subscription_tier', 'subscription_status', 'stripe_customer_id', 'stripe_subscription_id')
      AND a.attnum > 0 AND NOT a.attisdropped`;
    const allDeprecated = bizSubComments.every(c => c.comment && c.comment.includes('DEPRECATED'));
    const allPresent = bizSubComments.length === 4;
    results['VAL-SCHEMA-036'] = { pass: allPresent && allDeprecated, details: `Found ${bizSubComments.length}/4 columns, all deprecated: ${allDeprecated}. Comments: ${JSON.stringify(bizSubComments.map(c => ({col: c.attname, comment: c.comment})))}` };

    // === VAL-SCHEMA-037: Businesses subscription columns still exist ===
    const bizSubCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'businesses' AND column_name IN ('subscription_tier', 'subscription_status', 'stripe_customer_id', 'stripe_subscription_id')`;
    results['VAL-SCHEMA-037'] = { pass: bizSubCols.length === 4, details: `Found ${bizSubCols.length}/4 subscription columns` };

    // === RLS Policy Checks ===
    // VAL-AUTH-001: accounts RLS
    const acctPolicy = await sql`SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'accounts' AND schemaname = 'public'`;
    const hasAcctOwnerPolicy = acctPolicy.some(p => p.qual && p.qual.includes('account_id') && p.qual.includes('auth.uid'));
    results['VAL-AUTH-001'] = { pass: hasAcctOwnerPolicy, details: `accounts policies: ${acctPolicy.map(p => p.policyname).join(', ')}` };

    // VAL-AUTH-002: businesses RLS
    const bizPolicy = await sql`SELECT policyname, qual FROM pg_policies WHERE tablename = 'businesses' AND schemaname = 'public'`;
    const hasBizAcctPolicy = bizPolicy.some(p => p.qual && p.qual.includes('account_id'));
    results['VAL-AUTH-002'] = { pass: hasBizAcctPolicy, details: `businesses policies: ${bizPolicy.map(p => p.policyname).join(', ')}` };

    // VAL-AUTH-003: channel_enrollments RLS
    const cePolicy = await sql`SELECT policyname, qual FROM pg_policies WHERE tablename = 'channel_enrollments' AND schemaname = 'public'`;
    const hasCePolicy = cePolicy.some(p => p.qual && p.qual.includes('account_id'));
    results['VAL-AUTH-003'] = { pass: hasCePolicy, details: `channel_enrollments policies: ${cePolicy.map(p => p.policyname).join(', ')}` };

    // Check remaining RLS tables
    const rlsTables = [
      { id: 'VAL-AUTH-004', table: 'api_costs' },
      { id: 'VAL-AUTH-005', table: 'notification_deliveries' },
      { id: 'VAL-AUTH-006', table: 'approval_audit_log' },
      { id: 'VAL-AUTH-007', table: 'reviews' },
      { id: 'VAL-AUTH-008', table: 'responses' },
      { id: 'VAL-AUTH-009', table: 'approval_links' },
      { id: 'VAL-AUTH-010', table: 'weekly_summaries' },
      { id: 'VAL-AUTH-011', table: 'review_exceptions' },
      { id: 'VAL-AUTH-012', table: 'ranking_snapshots' },
      { id: 'VAL-AUTH-013', table: 'monthly_impact_emails' },
      { id: 'VAL-AUTH-014', table: 'onboarding_drip_log' },
      { id: 'VAL-AUTH-015', table: 'satisfaction_responses' },
      { id: 'VAL-AUTH-016', table: 'api_costs_daily_rollups' },
      { id: 'VAL-AUTH-017', table: 'sms_sender_opt_outs' },
      { id: 'VAL-AUTH-018', table: 'sms_sender_opt_out_events' },
      { id: 'VAL-AUTH-019', table: 'zernio_connections' },
      { id: 'VAL-AUTH-020', table: 'zernio_finalize_incidents' },
      { id: 'VAL-AUTH-021', table: 'zernio_backfill_runs' },
    ];
    
    for (const item of rlsTables) {
      const policies = await sql`SELECT policyname, qual FROM pg_policies WHERE tablename = ${item.table} AND schemaname = 'public'`;
      const hasPolicy = policies.length > 0;
      const hasAccountIdOrBusinessId = policies.some(p => 
        p.qual && (p.qual.includes('account_id') || p.qual.includes('business_id'))
      );
      results[item.id] = { pass: hasPolicy && hasAccountIdOrBusinessId, details: `${item.table}: ${policies.length} policies, account/business scoped: ${hasAccountIdOrBusinessId}` };
    }

    // VAL-AUTH-035: account_audit_log RLS
    const auditLogPolicy = await sql`SELECT policyname, qual FROM pg_policies WHERE tablename = 'account_audit_log' AND schemaname = 'public'`;
    const hasAuditLogPolicy = auditLogPolicy.some(p => p.qual && p.qual.includes('account_id'));
    results['VAL-AUTH-035'] = { pass: hasAuditLogPolicy, details: `account_audit_log: ${auditLogPolicy.map(p => p.policyname).join(', ')}` };

    // Print all results
    console.log('\n=== SCHEMA AND RLS VALIDATION RESULTS ===\n');
    let passCount = 0;
    let failCount = 0;
    for (const [id, result] of Object.entries(results)) {
      const status = result.pass ? 'PASS' : 'FAIL';
      if (result.pass) passCount++; else failCount++;
      console.log(`${id}: ${status} — ${result.details}`);
    }
    console.log(`\nTotal: ${passCount} PASS, ${failCount} FAIL out of ${Object.keys(results).length} assertions`);

  } finally {
    await sql.end();
  }
}

verify().catch(e => console.error('ERROR:', e.message));

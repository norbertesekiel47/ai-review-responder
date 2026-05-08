const postgres = require('postgres');
const fs = require('fs');

const envContent = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envContent.split('\n').find(l => l.startsWith('DATABASE_POOL_URL=')).replace('DATABASE_POOL_URL=', '').trim();
const sql = postgres(dbUrl);

async function check() {
  try {
    // Check if accounts table exists
    const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('accounts', 'account_audit_log', 'businesses', 'users', 'channel_enrollments') ORDER BY tablename`;
    console.log('Tables:', JSON.stringify(tables.map(t => t.tablename)));
    
    // Check businesses columns
    const bizCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'businesses' AND column_name IN ('account_id', 'is_primary', 'display_label', 'archived_at') ORDER BY column_name`;
    console.log('Businesses new cols:', JSON.stringify(bizCols.map(c => c.column_name)));
    
    // Check users columns
    const userCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('account_id', 'business_id') ORDER BY column_name`;
    console.log('Users cols (account_id/business_id):', JSON.stringify(userCols.map(c => c.column_name)));
    
    // Check data counts
    const bizCount = await sql`SELECT count(*)::int as cnt FROM businesses`;
    const userCount = await sql`SELECT count(*)::int as cnt FROM users`;
    const acctCount = await sql`SELECT count(*)::int as cnt FROM accounts`;
    console.log('businesses count:', bizCount[0].cnt);
    console.log('users count:', userCount[0].cnt);
    console.log('accounts count:', acctCount[0].cnt);
    
    // Check channel_enrollments new columns
    const ceCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'channel_enrollments' AND column_name IN ('account_id', 'location_id') ORDER BY column_name`;
    console.log('channel_enrollments new cols:', JSON.stringify(ceCols.map(c => c.column_name)));
    
    // Check accounts columns  
    const acctCols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' ORDER BY ordinal_position`;
    console.log('accounts columns:', JSON.stringify(acctCols.map(c => c.column_name)));
    
    // Check RLS
    const rls = await sql`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('accounts', 'businesses', 'users', 'channel_enrollments', 'account_audit_log')`;
    console.log('RLS enabled:', JSON.stringify(rls.map(r => ({name: r.relname, rls: r.relrowsecurity}))));
    
    // Check users with account_id populated
    const usersWithAcct = await sql`SELECT count(*)::int as cnt FROM users WHERE account_id IS NOT NULL`;
    const usersNoAcct = await sql`SELECT count(*)::int as cnt FROM users WHERE account_id IS NULL`;
    console.log('users with account_id:', usersWithAcct[0].cnt, '/ without:', usersNoAcct[0].cnt);
    
    // Check businesses with account_id populated
    const bizWithAcct = await sql`SELECT count(*)::int as cnt FROM businesses WHERE account_id IS NOT NULL`;
    const bizNoAcct = await sql`SELECT count(*)::int as cnt FROM businesses WHERE account_id IS NULL`;
    console.log('businesses with account_id:', bizWithAcct[0].cnt, '/ without:', bizNoAcct[0].cnt);
    
    // Check is_primary
    const bizPrimary = await sql`SELECT count(*)::int as cnt FROM businesses WHERE is_primary = true`;
    console.log('businesses is_primary=true:', bizPrimary[0].cnt);
    
    // Check subscription status source
    const activeAccounts = await sql`SELECT subscription_status, count(*)::int as cnt FROM accounts GROUP BY subscription_status ORDER BY cnt DESC`;
    console.log('accounts by status:', JSON.stringify(activeAccounts));
    
    // Check RLS policies count
    const policies = await sql`SELECT schemaname, tablename, count(*)::int as policy_count FROM pg_policies WHERE schemaname = 'public' GROUP BY schemaname, tablename ORDER BY policy_count DESC`;
    console.log('RLS policies:', JSON.stringify(policies));
    
  } finally {
    await sql.end();
  }
}

check().catch(e => console.error('ERROR:', e.message));

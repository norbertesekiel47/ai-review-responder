const postgres = require('postgres');
const fs = require('fs');
const envContent = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envContent.split('\n').find(l => l.startsWith('DATABASE_POOL_URL=')).replace('DATABASE_POOL_URL=', '').trim();
const sql = postgres(dbUrl);

async function check() {
  try {
    // Check idx_accounts_stripe_customer definition
    const stripeIdx = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_accounts_stripe_customer'`;
    console.log('VAL-SCHEMA-002 stripe index:', JSON.stringify(stripeIdx));
    
    // Check idx_users_owner_auth_by_account definition
    const userAcctIdx = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_users_owner_auth_by_account'`;
    console.log('VAL-SCHEMA-015 user auth index:', JSON.stringify(userAcctIdx));
    
    // Check businesses indexes with 'account' in name
    const bizIndexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'businesses' ORDER BY indexname`;
    console.log('All businesses indexes:');
    for (const i of bizIndexes) console.log(`  ${i.indexname}: ${i.indexdef}`);
    
    // Check accounts RLS policy qual
    const acctPolicy = await sql`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'accounts' AND schemaname = 'public'`;
    console.log('VAL-AUTH-001 accounts policy:', JSON.stringify(acctPolicy));
    
    // Check channel_enrollments_one_mobile_per_scope
    const mobileIdx = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'channel_enrollments_one_mobile_per_scope'`;
    console.log('VAL-SCHEMA-024 mobile index:', JSON.stringify(mobileIdx));
  } finally {
    await sql.end();
  }
}
check().catch(e => console.error(e.message));

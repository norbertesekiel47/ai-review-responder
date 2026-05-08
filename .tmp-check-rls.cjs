const postgres = require('postgres');
const fs = require('fs');
const envContent = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envContent.split('\n').find(l => l.startsWith('DATABASE_POOL_URL=')).replace('DATABASE_POOL_URL=', '').trim();
const sql = postgres(dbUrl);

async function check() {
  try {
    // Check the owner_account_id() helper function
    const fn = await sql`SELECT proname, prosrc FROM pg_proc WHERE proname = 'owner_account_id'`;
    console.log('owner_account_id function:', JSON.stringify(fn));
    
    // Check all RLS policies on accounts
    const policies = await sql`SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'accounts' AND schemaname = 'public'`;
    console.log('Accounts policies:', JSON.stringify(policies));
    
    // Verify RLS policies enforce account_id scope on key tables
    const checkTables = ['businesses', 'channel_enrollments', 'api_costs', 'notification_deliveries', 'approval_audit_log', 'account_audit_log'];
    for (const table of checkTables) {
      const p = await sql`SELECT policyname, qual FROM pg_policies WHERE tablename = ${table} AND schemaname = 'public'`;
      console.log(`${table} policies:`, JSON.stringify(p));
    }
    
    // Check users self-select policy
    const userPolicies = await sql`SELECT policyname, qual FROM pg_policies WHERE tablename = 'users' AND schemaname = 'public'`;
    console.log('users policies:', JSON.stringify(userPolicies));
  } finally {
    await sql.end();
  }
}
check().catch(e => console.error(e.message));

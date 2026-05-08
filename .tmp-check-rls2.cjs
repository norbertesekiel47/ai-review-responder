const postgres = require('postgres');
const fs = require('fs');
const envContent = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envContent.split('\n').find(l => l.startsWith('DATABASE_POOL_URL=')).replace('DATABASE_POOL_URL=', '').trim();
const sql = postgres(dbUrl);

async function check() {
  try {
    // Check RLS policies on tables that use business_id JOIN (not direct account_id)
    const joinTables = ['reviews', 'responses', 'approval_links', 'weekly_summaries', 'review_exceptions', 
      'ranking_snapshots', 'monthly_impact_emails', 'onboarding_drip_log', 'satisfaction_responses', 
      'api_costs_daily_rollups', 'sms_sender_opt_outs', 'sms_sender_opt_out_events', 
      'zernio_connections', 'zernio_finalize_incidents', 'zernio_backfill_runs'];
    
    for (const table of joinTables) {
      const p = await sql`SELECT policyname, qual FROM pg_policies WHERE tablename = ${table} AND schemaname = 'public'`;
      if (p.length > 0) {
        console.log(`${table}: ${p[0].policyname} — qual: ${p[0].qual}`);
      } else {
        console.log(`${table}: NO POLICY`);
      }
    }
    
    // Verify channel_enrollments insert qual
    const ceInsert = await sql`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'channel_enrollments' AND policyname = 'channel_enrollments_owner_insert'`;
    console.log('\nchannel_enrollments insert policy:', JSON.stringify(ceInsert));
  } finally {
    await sql.end();
  }
}
check().catch(e => console.error(e.message));

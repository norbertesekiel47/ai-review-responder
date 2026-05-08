const postgres = require('postgres');
const fs = require('fs');
const envContent = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envContent.split('\n').find(l => l.startsWith('DATABASE_POOL_URL=')).replace('DATABASE_POOL_URL=', '').trim();
const sql = postgres(dbUrl);

async function check() {
  try {
    // Check FK constraint deferrability
    const fks = await sql`SELECT conname, confrelid::regclass, conrelid::regclass, contype, condeferrable, condeferred 
      FROM pg_constraint WHERE conname IN ('fk_users_account', 'accounts_owner_user_id_fkey') 
      OR (conrelid = 'accounts'::regclass AND contype = 'f')
      OR (conrelid = 'users'::regclass AND contype = 'f')`;
    for (const fk of fks) {
      console.log(`${fk.conname}: deferrable=${fk.condeferrable}, deferred=${fk.condeferred}`);
    }
    
    // Try using SET CONSTRAINTS ALL DEFERRED
    console.log('\nTrying deferred constraint insert...');
    const { v7: uuidv7 } = require('uuid');
    const accountId = uuidv7();
    const businessId = uuidv7();
    const userId = uuidv7();
    const authId = 'cdec3ede-b434-4b56-9963-1697d4486dd9';
    const testEmail = 'test-validator@repworth.example.com';
    
    await sql.begin(async (tx) => {
      // Defer all constraints in this transaction
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      
      // Create accounts row (references users.id which doesn't exist yet - OK with deferred)
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status, stripe_customer_id, stripe_subscription_id)
        VALUES (${accountId}::uuid, ${userId}::uuid, 'Test Location', 'standard', 'active', 'cus_test_validator', 'sub_test_validator')
      `;
      
      // Create businesses row
      await tx`
        INSERT INTO businesses (id, account_id, is_primary, name, category, google_place_id, place_id_verified, tone, products_services, staff_names, highlight_facts, avoid_facts, sample_responses, owner_name, owner_email, owner_phone, subscription_tier, subscription_status, stripe_customer_id, stripe_subscription_id, onboarded_by)
        VALUES (${businessId}::uuid, ${accountId}::uuid, TRUE, 'Test Location', 'restaurant', 'ChIJtest123', TRUE, 'professional and friendly', 'Great food and service', ${['Alice', 'Bob']}, ${['Fresh ingredients', 'Friendly staff']}, ${['No artificial flavors']}, ${['Thank you!', 'Sorry!']}, 'Test Owner', ${testEmail}, '+1234567890', 'standard', 'active', 'cus_test_validator', 'sub_test_validator', 'seed-script')
      `;
      
      // Create users row (references accounts.id which now exists)
      await tx`
        INSERT INTO users (id, auth_id, name, email, phone, role, account_id)
        VALUES (${userId}::uuid, ${authId}, 'Test Owner', ${testEmail}, '+1234567890', 'owner', ${accountId}::uuid)
      `;
      
      // Create channel_enrollments row
      await tx`
        INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)
        VALUES (${uuidv7()}::uuid, ${accountId}::uuid, ${businessId}::uuid, 'email', ${testEmail}, 'verified', NOW())
      `;
    });
    
    console.log('SUCCESS! Test data created:');
    console.log('  accountId:', accountId);
    console.log('  businessId:', businessId);
    console.log('  userId:', userId);
    console.log('  authId:', authId);
    console.log('  email:', testEmail);
    
  } finally {
    await sql.end();
  }
}
check().catch(e => console.error('ERROR:', e.message));

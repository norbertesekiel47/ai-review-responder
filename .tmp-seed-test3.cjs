const postgres = require('postgres');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const { v7: uuidv7 } = require('uuid');

const envContent = fs.readFileSync('.env.local', 'utf8');
const lines = envContent.split('\n');
const dbUrl = lines.find(l => l.startsWith('DATABASE_POOL_URL=')).replace('DATABASE_POOL_URL=', '').trim();
const supabaseUrl = lines.find(l => l.startsWith('SUPABASE_URL=')).replace('SUPABASE_URL=', '').trim();
const serviceKey = lines.find(l => l.startsWith('SUPABASE_SERVICE_KEY=')).replace('SUPABASE_SERVICE_KEY=', '').trim();

const sql = postgres(dbUrl);
const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function seed() {
  try {
    const testEmail = 'test-validator@repworth.example.com';
    const testPassword = 'TestPass123!val';
    
    // 1. Get or create auth user
    const { data: { users } } = await supabase.auth.admin.listUsers();
    let existing = users?.find(u => u.email === testEmail);
    let authId;
    if (existing) {
      authId = existing.id;
      console.log('Existing auth user:', authId);
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: testEmail,
        password: testPassword,
        email_confirm: true,
      });
      if (error) { console.error('Auth error:', error.message); return; }
      authId = data.user.id;
      console.log('Created auth user:', authId);
    }

    // Check if app user already exists
    const existingUser = await sql`SELECT id, account_id FROM users WHERE auth_id = ${authId}`;
    if (existingUser.length > 0) {
      console.log('App user already exists:', JSON.stringify(existingUser));
      return;
    }

    const accountId = uuidv7();
    const businessId = uuidv7();
    const userId = uuidv7();
    
    // Use the same approach as createBusinessTx but work around circular FK
    // by temporarily setting account_id in users to NULL, then updating
    await sql.begin(async (tx) => {
      // Insert users row WITHOUT account_id first (work around circular FK)
      await tx`
        INSERT INTO users (id, auth_id, name, email, phone, role)
        VALUES (${userId}::uuid, ${authId}, 'Test Owner', ${testEmail}, '+1234567890', 'owner')
      `;
      
      // Insert accounts row (owner_user_id FK can now be satisfied)
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status, stripe_customer_id, stripe_subscription_id)
        VALUES (${accountId}::uuid, ${userId}::uuid, 'Test Location', 'standard', 'active', 'cus_test_validator', 'sub_test_validator')
      `;
      
      // Update users row to set account_id
      await tx`
        UPDATE users SET account_id = ${accountId}::uuid WHERE id = ${userId}::uuid
      `;
      
      // Insert businesses row
      await tx`
        INSERT INTO businesses (id, account_id, is_primary, name, category, google_place_id, place_id_verified, tone, products_services, staff_names, highlight_facts, avoid_facts, sample_responses, owner_name, owner_email, owner_phone, subscription_tier, subscription_status, stripe_customer_id, stripe_subscription_id, onboarded_by)
        VALUES (${businessId}::uuid, ${accountId}::uuid, TRUE, 'Test Location', 'restaurant', 'ChIJtest123', TRUE, 'professional and friendly', 'Great food and service', ${['Alice', 'Bob']}, ${['Fresh ingredients', 'Friendly staff']}, ${['No artificial flavors']}, ${['Thank you!', 'Sorry!']}, 'Test Owner', ${testEmail}, '+1234567890', 'standard', 'active', 'cus_test_validator', 'sub_test_validator', 'seed-script')
      `;
      
      // Insert channel_enrollments row
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
    console.log('  password:', testPassword);
    
  } finally {
    await sql.end();
  }
}
seed().catch(e => console.error('ERROR:', e.message));

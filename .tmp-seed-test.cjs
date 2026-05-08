const postgres = require('postgres');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

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
    // 1. Create a Supabase auth user
    const testEmail = 'test-validator@repworth.example.com';
    const testPassword = 'TestPass123!val';
    
    // First check if user exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existing = existingUsers?.users?.find(u => u.email === testEmail);
    
    let authId;
    if (existing) {
      authId = existing.id;
      console.log('Existing auth user found:', authId);
    } else {
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: testEmail,
        password: testPassword,
        email_confirm: true, // Auto-confirm for testing
      });
      if (authError) {
        console.error('Auth user creation failed:', authError.message);
        return;
      }
      authId = authData.user.id;
      console.log('Created auth user:', authId);
    }

    // 2. Check if account already exists for this user
    const existingUser = await sql`SELECT id, account_id FROM users WHERE auth_id = ${authId}`;
    if (existingUser.length > 0) {
      console.log('User already exists in app DB:', JSON.stringify(existingUser));
      return;
    }

    // 3. Create account + business + user in a single tx (mimicking createBusinessTx)
    const { v7: uuidv7 } = require('uuid');
    const accountId = uuidv7();
    const businessId = uuidv7();
    const userId = uuidv7();
    
    await sql.begin(async (tx) => {
      // Create users row FIRST (referenced by accounts.owner_user_id FK)
      await tx`
        INSERT INTO users (id, auth_id, name, email, phone, role, account_id)
        VALUES (
          ${userId}::uuid,
          ${authId},
          'Test Owner',
          ${testEmail},
          '+1234567890',
          'owner',
          ${accountId}::uuid
        )
      `;

      // Create accounts row
      await tx`
        INSERT INTO accounts (
          id, owner_user_id, display_name,
          subscription_tier, subscription_status,
          stripe_customer_id, stripe_subscription_id
        ) VALUES (
          ${accountId}::uuid,
          ${userId}::uuid,
          'Test Location',
          'standard',
          'active',
          'cus_test_validator',
          'sub_test_validator'
        )
      `;

      // Create businesses row (the primary location)
      await tx`
        INSERT INTO businesses (
          id, account_id, is_primary, name,
          category, google_place_id, place_id_verified,
          tone, products_services, staff_names, highlight_facts, avoid_facts, sample_responses,
          owner_name, owner_email, owner_phone,
          subscription_tier, subscription_status,
          stripe_customer_id, stripe_subscription_id,
          onboarded_by
        ) VALUES (
          ${businessId}::uuid,
          ${accountId}::uuid,
          TRUE,
          'Test Location',
          'restaurant',
          'ChIJtest123',
          TRUE,
          'professional and friendly',
          'Great food and service',
          ${['Alice', 'Bob']},
          ${['Fresh ingredients', 'Friendly staff']},
          ${['No artificial flavors']},
          ${['Thank you for your kind words! We appreciate your feedback.', 'We are sorry to hear about your experience. We will address this immediately.']},
          'Test Owner',
          ${testEmail},
          '+1234567890',
          'standard',
          'active',
          'cus_test_validator',
          'sub_test_validator',
          'seed-script'
        )
      `;

      // Create channel_enrollments row
      await tx`
        INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)
        VALUES (${uuidv7()}::uuid, ${accountId}::uuid, ${businessId}::uuid, 'email', ${testEmail}, 'verified', NOW())
      `;
    });

    console.log('Created test data:');
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

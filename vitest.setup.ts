// Dummy env vars for unit tests that transitively import db/server.
// Without these, `createClient(process.env.SUPABASE_URL!, ...)` throws at
// module-load time even when the test doesn't actually hit Supabase.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'dummy-service-key-for-tests';
process.env.DATABASE_POOL_URL =
  process.env.DATABASE_POOL_URL ?? 'postgres://test:test@localhost:5432/test';

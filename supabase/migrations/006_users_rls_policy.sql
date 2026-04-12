-- Minimal RLS policy: authenticated users can read their own users row.
-- auth_id is VARCHAR(255), auth.uid() returns UUID — cast to text for comparison.
-- This is the ONLY policy needed for Sprint 3. Browser clients do NOT query
-- business/review/response tables directly — admin data flows through server
-- API routes using the service-role client.

-- Enable RLS on users table (was missing from migration 001)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self_select ON users
  FOR SELECT
  TO authenticated
  USING (auth_id = auth.uid()::text);

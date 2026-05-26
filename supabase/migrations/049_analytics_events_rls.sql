-- Migration 049: enable RLS on analytics_events
--
-- Migration 046 created analytics_events without RLS — the only table-creating
-- migration in the repo that skipped it. In Supabase a public-schema table
-- without RLS is reachable through the anon PostgREST API, exposing account_id,
-- user_id, business_id, distinct_id and event properties. Enable RLS with no
-- policy (deny-all): server code reaches this table only via the Postgres.js
-- `postgres` role, which bypasses RLS, exactly like impersonation_sessions (048)
-- and accounts/account_audit_log (034).

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

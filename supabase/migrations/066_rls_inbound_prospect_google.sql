-- Migration 066: enable RLS on inbound_events, prospect_demos, google_connections
--
-- deep-scan §4.1 — these three tables (all created in 001) hold tenant / PII /
-- secret-shaped data but had NO `ENABLE ROW LEVEL SECURITY` anywhere, and none
-- were listed in scripts/ci/tenant-tables.ts, so ci:rls-audit was structurally
-- blind to them. In Supabase a public-schema table without RLS is reachable
-- through the anon PostgREST API.
--   - inbound_events     — raw webhook payloads (Stripe/Twilio/Resend/Zernio
--                          bodies); can contain phone numbers, emails, PII.
--   - prospect_demos     — business names, place ids, generated review/response
--                          snapshots.
--   - google_connections — access_token_encrypted / refresh_token_encrypted /
--                          encrypted_dek (legacy Google OAuth secrets). NOT
--                          dropped: owner-offboarding references it as a
--                          hard_delete purge target (table-disposition.ts,
--                          purge-stages.ts, purge-helpers.ts, purge-verification.ts).
--
-- Deny-all (enable RLS, NO policy): server code reaches these only via the
-- Postgres.js `postgres` role, which BYPASSES RLS — exactly like analytics_events
-- (049), impersonation_sessions (048), flagged_responses (051), accounts /
-- account_audit_log (034). App-layer reachability is already safe (verified in
-- the deep-scan: ingress + admin + the by-design public demo slug viewer all use
-- the service Postgres client); this adds the missing defense-in-depth layer and
-- lands together with the matching scripts/ci/tenant-tables.ts entries so
-- ci:rls-audit guards them going forward.
--
-- No table / column / data changes. Transactional — safe to apply in a SINGLE
-- transaction (no CONCURRENTLY). Apply staging-first, then production, both
-- Supabase projects in lockstep.

ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_demos ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_connections ENABLE ROW LEVEL SECURITY;

// scripts/ci/rls-tables.ts
//
// The RLS registry (#1300): every table in `public` that MUST carry row level
// security. This is the sole owner of "this table must have RLS enabled".
//
// WHY IT IS NOT `TENANT_TABLES`. Until #1300, `ci:rls-audit` and
// `ci:tenant-scope` both read `TENANT_TABLES`, so "must carry RLS" and "is
// tenant-scope audited" could not be expressed independently. The two
// questions genuinely differ: `job_outbox`, `admin_audit_log`,
// `poller_heartbeats`, `analytics_events`, `flagged_responses`,
// `impersonation_sessions`, `owner_leads`, `poller_cursors`,
// `solicitation_send_breaker` and `users` all carry RLS and are all reviewed
// as NOT tenant-scope audited (`REVIEWED_NOT_TENANT_SCOPED`), so before this
// file their RLS posture rested entirely on each one's own migration suite.
//
// WHY A LITERAL LIST RATHER THAN A DERIVED ONE. `RLS_REQUIRED_TABLES` could be
// spelled `[...TENANT_TABLES, ...REVIEWED_NOT_TENANT_SCOPED]` and would be
// correct today — and would re-create the exact coupling the ticket exists to
// remove: a table moved OUT of `TENANT_TABLES` for a tenant-scope reason would
// silently take its RLS requirement with it. Spelling the list out makes the
// two registries independent; `scripts/ci/__tests__/rls-audit.test.ts` asserts
// one-way containment (every table on either tenant-tables list is here), so
// the independence costs a failing test, never silent coverage loss.
//
// STALE ROWS are caught by `ci:rls-audit`'s LIVE arm, which reports
// `<table> missing from pg_class result` for a registry entry the schema no
// longer has. The static arm cannot see a dropped table: its migration still
// contains the `ENABLE ROW LEVEL SECURITY` that created it.
//
// THE FLOOR, NOT THE CEILING. `ci:rls-audit` fails when a listed table has RLS
// off; it never fails on unrequested extra RLS (migration 107's header states
// the same). The deny-all REVOKE guard in `rls-audit.ts` is the other half:
// RLS with zero policies filters rows, and removes no table privilege.

/**
 * Every `public` table that must have `relrowsecurity = true`.
 *
 * Today that is every live table (production and staging were both measured at
 * 58 tables, RLS off on 0, during #1176 on 2026-09-16), and the entries are
 * grouped by why each table is on the list rather than sorted, so a reviewer
 * reads the reason with the name.
 */
export const RLS_REQUIRED_TABLES = [
  // --- Tenant roots and owner-facing tenant data -------------------------
  'accounts',
  'businesses',
  'users',
  'channel_enrollments',
  'reviews',
  'responses',
  'approval_links',
  'approval_audit_log',
  'account_audit_log',
  'account_offboardings',
  'account_offboarding_tokens',
  'auto_approval_policies',
  'notification_deliveries',
  'api_costs',
  'api_costs_daily_rollups',
  'weekly_summaries',
  'monthly_impact_emails',
  'onboarding_drip_log',
  'onboarding_demos',
  'satisfaction_responses',
  'review_exceptions',
  'ranking_snapshots',
  'competitor_snapshots',
  'zernio_connections',
  'zernio_finalize_incidents',
  'zernio_backfill_runs',

  // --- Solicitation (migrations 086–110) ---------------------------------
  'contact_csv_uploads',
  'solicitation_contacts',
  'solicitation_visits',
  'solicitation_batches',
  'solicitation_asks',
  'solicitation_outreach',
  'solicitation_consent',
  'solicitation_suppressions',
  'solicitation_unsubscribe_tokens',
  'solicitation_suppression_corrections',
  'solicitation_send_breaker',

  // --- Agentic platform (migrations 071–121) -----------------------------
  'agent_runs',
  'agent_run_steps',
  'agent_outcomes',
  'review_escalations',
  'judge_verdicts',
  'refusal_events',
  'agent_conversations',
  'agent_turns',
  'agent_proposals',
  'agent_unsupported_requests',

  // --- Platform spine and admin control plane ----------------------------
  // Not tenant-scope audited (`REVIEWED_NOT_TENANT_SCOPED`), and the reason
  // #1300 exists: each of these depended on its own migration suite alone.
  'job_outbox',
  'admin_audit_log',
  'poller_heartbeats',
  'poller_cursors',
  'analytics_events',
  'flagged_responses',
  'impersonation_sessions',
  'inbound_events',
  'prospect_demos',
  'google_connections',
  'owner_leads',
] as const;

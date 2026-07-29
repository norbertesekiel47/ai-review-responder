export const TENANT_TABLES = [
  'accounts',
  'businesses',
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
  'weekly_summaries',
  'monthly_impact_emails',
  'onboarding_drip_log',
  'onboarding_demos',
  'satisfaction_responses',
  'api_costs_daily_rollups',
  'review_exceptions',
  'ranking_snapshots',
  'competitor_snapshots',
  'zernio_connections',
  'zernio_finalize_incidents',
  'zernio_backfill_runs',
  // Owner-read-only RLS (migration 086, #541 contacts/visits CSV ingestion) —
  // mirrors competitor_snapshots' RLS shape above.
  'contact_csv_uploads',
  'solicitation_contacts',
  'solicitation_visits',
  // Owner-read-only RLS (migration 088, #543 Solicitation executor).
  // Batch SELECT also requires built_at IS NOT NULL at the policy layer so
  // partial/failed logical fan-out never becomes owner-visible.
  'solicitation_batches',
  'solicitation_asks',
  // Owner-read-only RLS (migration 091, #624 send-mode artifact table) — the
  // owner SELECT policy carries the D6a moderation carve-out. Carries
  // account_id/business_id; the ArchivalPoller body-redaction sweep is
  // deliberately cross-tenant and is exempted in tenant-scope-allowlist.ts.
  'solicitation_outreach',
  // Deny-all RLS (migration 066, deep-scan §4.1) — listed so ci:rls-audit
  // guards them. These are NOT account/business-scoped: raw webhook payloads,
  // sales-demo snapshots, and legacy Google OAuth secrets. Their SQL touchpoints
  // are exempt via tenant-scope-allowlist.ts (ingress / background / admin /
  // worker-job / pre-auth-token categories), not because they carry a tenant id.
  'inbound_events',
  'prospect_demos',
  'google_connections',
  // Deny-all RLS (migration 071, agent run spine) — listed so ci:rls-audit
  // guards them. Written ONLY by src/lib/agents/run-spine.ts inside pipeline
  // transactions that already carry account/business scope; run-keyed spine
  // queries are exempt via tenant-scope-allowlist.ts (worker-job-scoped), not
  // because they lack a tenant id (agent_runs/agent_outcomes carry account_id).
  'agent_runs',
  'agent_run_steps',
  'agent_outcomes',
  // Deny-all RLS (migration 073, WS3 Guardian escalation) — carries account_id/
  // business_id; written by src/lib/escalations/* inside pipeline transactions
  // that already carry account/business scope; non-owner-scoped statements
  // exempted via tenant-scope-allowlist.ts.
  'review_escalations',
  // Deny-all RLS (migration 076, WS6 Judge verdicts) — carries account_id/
  // business_id and is written only from tenant-scoped JudgeWorker transactions.
  // Cross-tenant sweep anti-joins are exempted explicitly in the allowlist.
  'judge_verdicts',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

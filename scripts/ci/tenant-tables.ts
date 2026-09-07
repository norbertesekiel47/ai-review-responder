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
  // Deny-all RLS (migration 093, #625 consent ledger) — zero policies, the
  // auto_approval_policies posture (invariant #14). Business-scoped via
  // business_id; deliberately carries NO account_id (spec §3.2), so
  // account-level sweeps join through businesses.
  'solicitation_consent',
  // Deny-all RLS (migration 096, #643 Suppression ledger) — zero policies, the
  // auto_approval_policies posture (invariant #14). Not decorative here: a
  // direct client read of a `global` row would expose the account_id
  // provenance the spec forbids surfacing.
  //
  // solicitation_suppressions carries account_id as the Suppression scope, NOT
  // as a denormalization: the row does not hang off a business, so there is
  // nothing for it to drift from. Its `global` arm is deliberately
  // cross-account — a recipient-authored opt-out applies to every tenant — and
  // is exempted in tenant-scope-allowlist.ts.
  //
  // solicitation_unsubscribe_tokens carries account_id as provenance only, and
  // the offboarding purge scrubs it to NULL while keeping the row: an
  // Unsubscribe token must still redeem after the account that minted it is
  // gone.
  'solicitation_suppressions',
  'solicitation_unsubscribe_tokens',
  // Deny-all RLS (migration 098, #645 Correction path audit sink) — zero
  // policies, same posture: a row names a recipient's Normalized handle, so a
  // direct client read would expose that an identified person's opt-out was
  // removed.
  //
  // It carries account_id, created_by_user_id and note copied off the row it
  // records the removal of — the evidence behind the corrected assertion
  // (D-A11). Listed here rather than named around the detector: the honest
  // spelling is what keeps the retention obligation visible. Written only by
  // the admin Correction path and read only by the admin lookup, both behind
  // requireAdminWithAal2 and both exempted in tenant-scope-allowlist.ts.
  'solicitation_suppression_corrections',
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
  // Deny-all RLS (migration 116, the Refusal ledger) — carries account_id and
  // a nullable business_id, and is written only from the tenant-scoped
  // transaction that made each decision. The account-offboarding purge deletes
  // it account-scoped; the retention sweep arrives with #1009 and will need
  // its own cross-tenant allowlist exemption then, not now.
  'refusal_events',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

export type TenantScopeColumn = 'id' | 'account_id' | 'business_id';

/**
 * The tenant-identity columns each tenant table PHYSICALLY carries, as
 * `ci:tenant-scope` may cite them: `accounts` is identified by `id`,
 * `businesses` by `id` + `account_id`, every other table by whichever of
 * `account_id` / `business_id` it has. An empty list means the table has no
 * tenant column at all and reaches its tenant only through a bridge the audit
 * names explicitly (or an allowlist entry).
 *
 * Why the audit needs this: PostgreSQL resolves an unqualified column in a
 * subquery OUTWARD when the local relation lacks it.
 * `EXISTS (SELECT 1 FROM reviews WHERE account_id = $1)` compiles — reviews
 * has no `account_id`, so the predicate reads the OUTER row's — and restricts
 * nothing. A scope predicate is therefore proof only on a column the table
 * actually has. Keep this map in lockstep with the schema:
 * `scripts/ci/__tests__/tenant-tables.integration.test.ts` asserts every row
 * against information_schema at migration head. A table added to
 * TENANT_TABLES without a row here fails typecheck.
 */
export const TENANT_SCOPE_COLUMNS: Record<TenantTable, readonly TenantScopeColumn[]> = {
  accounts: ['id'],
  businesses: ['id', 'account_id'],
  channel_enrollments: ['account_id', 'business_id'],
  reviews: ['business_id'],
  responses: ['business_id'],
  approval_links: ['business_id'],
  approval_audit_log: ['account_id', 'business_id'],
  account_audit_log: ['account_id'],
  account_offboardings: ['account_id'],
  account_offboarding_tokens: [],
  auto_approval_policies: ['account_id'],
  notification_deliveries: ['account_id', 'business_id'],
  api_costs: ['account_id', 'business_id'],
  weekly_summaries: ['business_id'],
  monthly_impact_emails: ['business_id'],
  onboarding_drip_log: ['business_id'],
  onboarding_demos: ['business_id'],
  satisfaction_responses: ['business_id'],
  api_costs_daily_rollups: ['business_id'],
  review_exceptions: ['business_id'],
  ranking_snapshots: ['business_id'],
  competitor_snapshots: ['business_id'],
  zernio_connections: ['business_id'],
  zernio_finalize_incidents: ['business_id'],
  zernio_backfill_runs: ['business_id'],
  contact_csv_uploads: ['account_id', 'business_id'],
  solicitation_contacts: ['business_id'],
  solicitation_visits: ['business_id'],
  solicitation_batches: ['account_id', 'business_id'],
  solicitation_asks: ['account_id', 'business_id'],
  solicitation_outreach: ['account_id', 'business_id'],
  solicitation_consent: ['business_id'],
  solicitation_suppressions: ['account_id'],
  solicitation_unsubscribe_tokens: ['account_id', 'business_id'],
  solicitation_suppression_corrections: ['account_id'],
  inbound_events: [],
  prospect_demos: [],
  google_connections: ['business_id'],
  agent_runs: ['account_id', 'business_id'],
  agent_run_steps: [],
  agent_outcomes: ['account_id', 'business_id'],
  review_escalations: ['account_id', 'business_id'],
  judge_verdicts: ['account_id', 'business_id'],
  // business_id is NULL for the account-wide autonomy_suspended lane, so a
  // per-location read is `account_id = $1 AND (business_id = $2 OR business_id
  // IS NULL)` — both columns are in scope, neither alone is (migration 116).
  refusal_events: ['account_id', 'business_id'],
};

/**
 * Every `public` table the tenant-scope audit deliberately does NOT cover,
 * with the reviewed reason (#894 Step 3). The completeness contract, enforced
 * by `scripts/ci/__tests__/tenant-tables.integration.test.ts`: every live
 * `public` table appears in EXACTLY ONE of `TENANT_TABLES` or this list — a
 * new table forces a deliberate decision, a table on both lists fails, and a
 * listed table that no longer exists fails (no stale rows).
 *
 * Keyed on "is a public table the audit does not cover, for a stated reason"
 * — NOT on tenant-column presence: `solicitation_send_breaker` carries no
 * tenant column at all and still needs an entry, which a column-presence
 * predicate could never see.
 *
 * Adding a table here is a REVIEW, not a formality: silence from
 * `ci:tenant-scope` means "not audited", never "safe". Do not move a table
 * here to quiet a finding — that is what the allowlist (with its baseline
 * gate) is for.
 */
export const REVIEWED_NOT_TENANT_SCOPED: readonly { table: string; reason: string }[] = [
  {
    table: 'admin_audit_log',
    reason:
      'Admin control-plane actor trail (migration 117, #468): carries NO tenant column — `actor_user_id` is an ADMIN, and admins have no account. Deny-all RLS with client-role privileges revoked; the only writer is writeAdminAuditLog (src/lib/audit/log.ts) over the RLS-bypassing Postgres.js role. TABLE_DISPOSITIONS: not_applicable (the actor is always an admin, never an offboarded owner).',
  },
  {
    table: 'analytics_events',
    reason:
      'Analytics event outbox: rows carry tenant ids as event attributes, but every reader is the platform dispatch poller or an admin rollup — cross-tenant by design; no per-tenant access path flows through this table.',
  },
  {
    table: 'flagged_responses',
    reason:
      'Held-draft flag rows (invariant #4): admin dispositions address the flag row by id behind the admin gate, alerting counts are cross-tenant, and owner-facing holds ride the RESPONSE row (src/lib/moderation/held-draft.ts owns the convention note).',
  },
  {
    table: 'impersonation_sessions',
    reason:
      'Admin impersonation audit trail: the actor is an ADMIN; reads are admin-only session lookups, not tenant data paths.',
  },
  {
    table: 'job_outbox',
    reason:
      'Transactional outbox (invariant #2): platform dispatch spine — scoping rides the enqueuing transaction; src/lib/solicitation/batch-view.ts carries the canonical convention comment.',
  },
  {
    table: 'owner_leads',
    reason:
      'Pre-signup marketing intake: no account exists yet, so there is no tenant to scope by.',
  },
  {
    table: 'poller_cursors',
    reason: 'Worker poller bookkeeping: pure platform state, no tenant data.',
  },
  {
    table: 'solicitation_send_breaker',
    reason:
      'Platform-scoped send circuit breaker (migration 110): carries NO tenant column — its only user reference (reset_by) is an actor, not a tenant. The entry a column-presence predicate could never demand.',
  },
  {
    table: 'users',
    reason:
      'The BRIDGE relation (#894 Step 2): identity side of invariant #8. Carries account_id, but the audit proves tenant scope THROUGH anchored users bindings (auth_id + the bridge shapes) rather than auditing users rows themselves.',
  },
];

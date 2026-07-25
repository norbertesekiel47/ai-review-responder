# RLS Inventory

RepWorth uses authenticated Supabase reads for owner-facing data and service-role Postgres.js for trusted writes. Tenant tables must keep row level security enabled even when most durable writes are enforced in application code.

Run `pnpm ci:rls-audit` to verify the required tables below still have `relrowsecurity = true`. The audit uses `TEST_DATABASE_POOL_URL` first, then `DATABASE_POOL_URL`; if neither is set, it prints a skip message and exits successfully.

Rows marked `— (deny-all)` in the Scope column are **not** owner-scoped by an `account_id`/`business_id` predicate. They are listed here (and in `TENANT_TABLES`) so the audit keeps RLS enabled on them as a defense-in-depth backstop — server access is via the RLS-bypassing Postgres.js `postgres` role, and their SQL touchpoints are exempted in `scripts/ci/tenant-scope-allowlist.ts` for structural reasons (provider event id, opaque slug, global retention, admin role, or offboarding job scope).

| Table | Scope column | Enforcement note |
| --- | --- | --- |
| `accounts` | `id` | Billing-parent rows are tenant roots. Owner reads compare `accounts.id` to `owner_account_id()`; service-role writes remain app-enforced. |
| `businesses` | `account_id` | Location rows belong to one billing account. Owner reads are account-scoped; service-role writes must validate active account or active location ownership. |
| `channel_enrollments` | `account_id`, `business_id`, `location_id` | Owner channel rows are account-scoped. Direct owner INSERT is revoked; verified enrollment writes go through service-role verification flows. |
| `reviews` | `business_id` | Reviews inherit tenant scope through their location. RLS owner reads join through `businesses.account_id`. |
| `responses` | `business_id` | Drafts and published-response state inherit tenant scope through both `business_id` and `review_id`. |
| `approval_links` | `business_id` | Approval-token metadata is tenant-scoped. Raw tokens are never stored; owner reads remain behind RLS. |
| `auto_approval_policies` | `account_id` and `location_id` | Auto-approval policy rows are scoped to the billing account with optional per-location overrides. RLS is enabled with no authenticated DML policies; settings routes must enforce session-derived account/location scope server-side. |
| `notification_deliveries` | `business_id` and `account_id` | Delivery evidence is tenant-scoped and may also be queried by response ID for worker recovery. |
| `api_costs` | `account_id` and `business_id` | Cost records support account-level and location-level reporting; admin-only global reports are explicitly allowlisted in the SQL scope audit. |
| `weekly_summaries` | `business_id` | Weekly owner summaries inherit tenant scope through the target location. |
| `monthly_impact_emails` | `business_id` | Monthly impact emails inherit tenant scope through the target location. |
| `onboarding_drip_log` | `business_id` | Onboarding drip claims and delivery records inherit tenant scope through the target location. |
| `onboarding_demos` | `user_id` and `business_id` | Pre-pay demo rows inherit tenant scope through the authenticated owner and generated business location. Owner reads are SELECT-only; demo creation, generation, archive, and cleanup remain service-role/app-enforced. |
| `satisfaction_responses` | `business_id` | Owner feedback responses inherit tenant scope through the target location. |
| `api_costs_daily_rollups` | `business_id` | Cost rollups inherit tenant scope through the target location; account-level reads join through `businesses.account_id`. |
| `review_exceptions` | `business_id` | Exception records are location-scoped, including identity-collision and publisher failure cases. |
| `ranking_snapshots` | `business_id` | Ranking history is location-scoped by keyword and snapshot date. |
| `competitor_snapshots` | `business_id` | Competitor pack rows are location-scoped by keyword and snapshot date. |
| `contact_csv_uploads` | `account_id` and `business_id` | Contacts CSV upload rows (raw CSV until terminal state, consent attestation, ingest report) are owner SELECT-only; writes are service-role via the upload route and csv_ingest worker (migration 086). |
| `solicitation_contacts` | `business_id` | Solicitation contacts (normalized handles — PII) are location-scoped; owner reads join through `businesses.account_id`, writes are worker-only (migration 086). |
| `solicitation_visits` | `business_id` | Visit-ledger rows inherit tenant scope through the target location; a composite FK pins each visit to its contact's location (migration 086). |
| `solicitation_batches` | `account_id` and `business_id` | Solicitation batch lifecycle rows are owner SELECT-only. The policy itself requires `built_at IS NOT NULL`, so pending or failed construction is not owner-visible (migration 088). |
| `solicitation_asks` | `account_id` and `business_id` | Authoritative per-candidate send/withhold decisions are owner SELECT-only and tenant-pinned to both their batch and contact. In watch-mode, `send` means would-send only (migration 088). |
| `approval_audit_log` | `account_id` and `business_id` | Approval forensics are denormalized with account and location scope for owner/admin evidence queries. |
| `account_audit_log` | `account_id` | Account-level audit entries are scoped to the billing parent. |
| `account_offboardings` | `account_id` | Owner offboarding lifecycle rows are account-scoped and service-only. RLS is deny-all with no authenticated owner policies; routes and workers must enforce session/account scope in application code. |
| `account_offboarding_tokens` | `account_offboarding_id` via `account_offboardings.account_id` | Keep-my-data token metadata inherits account scope through its offboarding row. Raw tokens are never stored; service-role routes validate the hashed token and lifecycle state. |
| `zernio_connections` | `business_id` | Zernio mappings are per location; owner reads join through the owning business account. |
| `zernio_finalize_incidents` | `business_id` | Finalize-unknown incident rows inherit tenant scope through the affected location. |
| `zernio_backfill_runs` | `business_id` | Backfill summary rows inherit tenant scope through the connected location. |
| `inbound_events` | — (deny-all) | Raw webhook payloads (Stripe/Twilio/Resend/Zernio) — can carry PII. Not account/business-columned. Deny-all RLS (migration 066, deep-scan §4.1); reached only via the RLS-bypassing Postgres.js `postgres` role (ingress, archival, admin payment-success, offboarding scrub). |
| `prospect_demos` | — (deny-all) | Admin sales-demo snapshots + the by-design public slug viewer. Not account/business-columned. Deny-all RLS (migration 066, deep-scan §4.1); all access via the RLS-bypassing Postgres.js `postgres` role. |
| `google_connections` | — (deny-all) | Legacy Google OAuth token store (`*_encrypted`, `encrypted_dek`), superseded by Zernio; retained as an owner-offboarding `hard_delete` purge target. Deny-all RLS (migration 066, deep-scan §4.1); no direct SQL touchpoint — accessed only via identifier-interpolating purge helpers. |
| `agent_runs` | — (deny-all) | Agent run spine: one attributed run per pipeline pass over a subject (carries `account_id`/`business_id`, but run-keyed spine queries are allowlisted structurally). Deny-all RLS (migration 071); written only by `src/lib/agents/run-spine.ts` via the RLS-bypassing Postgres.js `postgres` role; owner reads arrive later via server routes. |
| `agent_run_steps` | — (deny-all) | Ordered attribution steps within an agent run; scoped through `agent_run_id` only (no direct tenant column). Deny-all RLS (migration 071); written only by `src/lib/agents/run-spine.ts` via the RLS-bypassing Postgres.js `postgres` role. |
| `agent_outcomes` | — (deny-all) | Durable per-agent outcome facts for attribution/reporting (carries `account_id`/`business_id`; deduped per run + outcome kind). Deny-all RLS (migration 071); written only by `src/lib/agents/run-spine.ts` via the RLS-bypassing Postgres.js `postgres` role. |
| `review_escalations` | `account_id` | Guardian escalation state (WS3): one row per raised escalation, referencing a review + agent run. Deny-all RLS; server routes + workers only (WS3). |
| `judge_verdicts` | — (deny-all) | Post-hoc Judge verdicts carry `account_id`/`business_id` for attribution but expose no authenticated policy. Deny-all RLS (migration 076); Judge workers write and sweep them only through server-side modules using the RLS-bypassing Postgres.js `postgres` role. |
<!-- `sms_sender_opt_outs` and `sms_sender_opt_out_events` dropped by migration 061 (SMS channel removal). -->

The audit is intentionally small: it verifies that required tenant tables appear in `pg_class` for the public schema and that RLS is enabled. It does not prove every policy predicate. Policy behavior remains covered by focused integration tests and route/module tests.

# RLS Inventory

RepWorth uses authenticated Supabase reads for owner-facing data and service-role Postgres.js for trusted writes. Tenant tables must keep row level security enabled even when most durable writes are enforced in application code.

Run `pnpm ci:rls-audit` to verify the required tables below still have `relrowsecurity = true`. The audit uses `TEST_DATABASE_POOL_URL` first, then `DATABASE_POOL_URL`; if neither is set, it prints a skip message and exits successfully.

| Table | Scope column | Enforcement note |
| --- | --- | --- |
| `accounts` | `id` | Billing-parent rows are tenant roots. Owner reads compare `accounts.id` to `owner_account_id()`; service-role writes remain app-enforced. |
| `businesses` | `account_id` | Location rows belong to one billing account. Owner reads are account-scoped; service-role writes must validate active account or active location ownership. |
| `channel_enrollments` | `account_id`, `business_id`, `location_id` | Owner channel rows are account-scoped. Direct owner INSERT is revoked; verified enrollment writes go through service-role verification flows. |
| `reviews` | `business_id` | Reviews inherit tenant scope through their location. RLS owner reads join through `businesses.account_id`. |
| `responses` | `business_id` | Drafts and published-response state inherit tenant scope through both `business_id` and `review_id`. |
| `approval_links` | `business_id` | Approval-token metadata is tenant-scoped. Raw tokens are never stored; owner reads remain behind RLS. |
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
| `approval_audit_log` | `account_id` and `business_id` | Approval forensics are denormalized with account and location scope for owner/admin evidence queries. |
| `account_audit_log` | `account_id` | Account-level audit entries are scoped to the billing parent. |
| `zernio_connections` | `business_id` | Zernio mappings are per location; owner reads join through the owning business account. |
| `zernio_finalize_incidents` | `business_id` | Finalize-unknown incident rows inherit tenant scope through the affected location. |
| `zernio_backfill_runs` | `business_id` | Backfill summary rows inherit tenant scope through the connected location. |
| `sms_sender_opt_outs` | `handle` via `channel_enrollments` | Sender-level TCPA opt-out state is owner-readable only when its handle belongs to an SMS/WhatsApp channel enrollment for the owner account. |
| `sms_sender_opt_out_events` | `handle` via `channel_enrollments` | Opt-out event history follows the same handle bridge as `sms_sender_opt_outs`. |

The audit is intentionally small: it verifies that required tenant tables appear in `pg_class` for the public schema and that RLS is enabled. It does not prove every policy predicate. Policy behavior remains covered by focused integration tests and route/module tests.

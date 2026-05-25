# Wave 1 Foundation Launch Risk Design

Status: ready for user review

Date: 2026-05-25

## Context

`docs/sass_ready/README.md` defines Wave 1 as the foundation / launch-risk wave after Step 0 decisions and Step 1 keystones. Step 0 and Step 1 are complete. The remaining Wave 1 work should reduce the risks that can make an early SaaS launch unrecoverable:

- Cross-tenant data leakage.
- Billing or invoice drift.
- Missing approval evidence in customer disputes.
- Inaccurate public legal, security, or sub-processor claims.
- Obvious security gaps before broader growth work.

This design covers the Wave 1 subset of:

- Spec 03: Multi-tenancy & Data Isolation.
- Spec 05: Billing & Subscription Lifecycle.
- Spec 09: Security & Compliance.
- Spec 17: Legal & Compliance Docs.
- Spec 29: RepWorth-specific Gap 1 and Gap 2 only.

It deliberately does not implement the full contents of those source specs. Later-wave items stay later.

## Selected Approach

Use an evidence-first launch gate. The wave ships a coordinated proof layer around the systems most likely to create launch-ending risk:

1. Tenant isolation can be proved by CI and integration tests.
2. Stripe state and RepWorth billing state can be reconciled within one hour.
3. Every approval creates immutable evidence of the exact response text approved.
4. Public legal and security claims match reality.
5. Review ingestion rejects likely PHI before persistence.

Rejected approaches:

- Customer-visible risk layer: would include fuller past-due UX, dunning emails, and Trust Center polish. That blends Wave 1 with Wave 2 activation work.
- Compliance-first paper trail: would prioritize docs and lawyer/external tasks before isolation, billing, and approval evidence. That delays the technical proofs with the highest launch-risk reduction.
- Five independent specs: clearer per-spec ownership, but duplicates billing, legal, security, and migration coordination across closely related work.

## Scope

In scope:

- RLS inventory and CI RLS audit for tenant-scoped tables.
- SQL tenant-scope audit for inline Postgres.js `sql\`...\`` queries in `src/` and `worker/`.
- A cross-tenant integration test design and first guarded test suite using `TEST_DATABASE_POOL_URL`.
- Subscription-level Stripe reconciliation and multi-location upcoming-invoice comparison.
- Pilot invoice review process using `accounts.flags.is_pilot`.
- `security.txt`, `/security`, security docs, vendor/access registers, and secrets rotation runbooks.
- Security scanning gates that can run without private production secrets, plus documented staging-gated scans.
- CSP nonce hardening plan with report-only rollout before enforcement.
- PHI scanner on Zernio review ingest before review persistence.
- Canonical `/legal/*` legal routes with redirects from current `/terms` and `/privacy`.
- Reconciled sub-processor list that only claims live vendors in the data path.
- AI disclosure at owner approval moments.
- Approval audit content snapshot in `approval_audit_log`.

Out of scope:

- GBP-direct fallback POC and Zernio commercial contingency plan.
- LLM monthly cost rollups and gross-margin dashboard.
- CSV import client-side polish.
- Support grant-extension action and support macros.
- Broad Trust Center buildout beyond `/security` and legal/security links.
- Full dunning email lifecycle, cancellation survey, Stripe Tax rollout, and chargeback tabletop.
- MFA, team membership schema, support impersonation, and other Spec 04 / Spec 13 auth hardening.
- Full day-variant past-due customer UX. `accounts.past_due_at` is already shipped by Step 1, but visible past-due UX belongs to Wave 2 and is not part of this Wave 1 implementation.
- `legal_acceptances` table, re-accept modal, and login-blocking legal acceptance flow. Wave 1 adds legal document version metadata and external review status; acceptance logging is a later legal-hardening slice.

## Architecture

This is one umbrella design with five implementation slices:

1. Tenant isolation proofs.
2. Billing and invoice reconciliation.
3. Security launch controls.
4. Legal and compliance accuracy.
5. RepWorth-specific approval and invoice evidence.

The slices share acceptance criteria and migration coordination. Billing reconciliation covers both Spec 05 and Spec 29 Gap 2. `/security` and sub-processor accuracy are shared by Spec 09 and Spec 17. Approval audit content snapshot is both Spec 29 Gap 1 and legal dispute evidence.

Implementation should be sequenced to land the lowest-level proofs first:

1. Approval audit migration and writer changes.
2. Tenant and RLS CI audits.
3. Billing reconciliation extension.
4. PHI scanner and security surfaces.
5. Legal routes, public docs, AI disclosure, and external acceptance gates.

The sequence can be adjusted during implementation planning if migration numbering or test harness work makes another order more efficient.

Implementation PR granularity:

- Prefer one PR per slice rather than one large Wave 1 PR.
- Land Slice 5 approval snapshot first because it is the lowest-level schema/evidence proof and has limited dependencies.
- Keep billing reconciliation, tenant CI scripts, security controls, and legal route/content changes separately reviewable.
- Each PR should update only the source readiness spec checkboxes it actually closes.

## Slice 1: Tenant Isolation Proofs

Source spec: `docs/sass_ready/03-multitenancy-isolation.md`.

### Current Repo Anchors

- Service-role Postgres.js client: `src/lib/db/server.ts`.
- Account/location guard helpers: `src/lib/db/account-guard.ts`.
- RLS migrations: `supabase/migrations/035_rls_policies.sql`, `040_rls_tightening.sql`, `041_rls_missing_revokes.sql`.
- Existing account scope tests: `src/app/api/dashboard/__tests__/scope-route.test.ts`.
- Existing denormalized admin query tests: `src/lib/admin/__tests__/denorm-queries.test.ts`.
- CI base gate: `.github/workflows/ci.yml`.

### Design

RepWorth has two tenant-enforcement paths:

- Service-role Postgres.js writes bypass RLS and must be guarded by app-layer `WHERE account_id = ...` or a provably scoped `business_id` join.
- Authenticated Supabase reads use RLS through the `owner_account_id()` model keyed to Supabase Auth identity.

Wave 1 should prove both paths rather than introducing a repository rewrite.

Add `scripts/ci/rls-audit.ts`:

- Connects with `TEST_DATABASE_POOL_URL` or `DATABASE_POOL_URL`.
- Reads `pg_class.relrowsecurity` for the tenant-scoped table inventory.
- Fails non-zero when a required tenant table lacks RLS.
- Produces a concise console report suitable for CI logs.

Add `docs/security/rls-inventory.md`:

- Lists each tenant-scoped table.
- Records whether it is RLS-covered, service-role-only, or intentionally global.
- Explains that RLS does not protect service-role write paths.

Add `scripts/ci/tenant-scope-audit.ts`:

- Scans TypeScript files in `src/` and `worker/`.
- Parses or conservatively extracts `sql\`...\`` tagged template literals.
- Flags `SELECT`, `UPDATE`, and `DELETE` statements against tenant-scoped tables unless they include an `account_id` predicate or a scoped `business_id` predicate/join.
- Maintains an explicit allowlist file with a justification per exception, such as global admin metrics or migration scripts.
- Starts conservative: false positives should fail locally during implementation, then be resolved by improving patterns or adding reviewed allowlist entries.

Add a guarded cross-tenant integration test:

- File: `src/__tests__/tenant-isolation.test.ts` or a closer existing integration-test location if the implementation plan identifies one.
- Requires `TEST_DATABASE_POOL_URL`.
- Seeds two accounts with multiple businesses, reviews, responses, approval links, approval audit rows, and account audit rows.
- Exercises representative authenticated read/list/update paths as account A and asserts no account B row is returned or modified.
- Skips gracefully when `TEST_DATABASE_POOL_URL` is absent, but CI instructions should include the future hard-gate command once DB-backed CI secrets exist.

Add `docs/security/tenant-isolation.md`:

- Explains the two-path model.
- Documents the CI guard expectations.
- Documents the cross-tenant test fixture.
- Defines how to review tenant-scope allowlist changes.

### Acceptance Criteria

- `scripts/ci/rls-audit.ts` exits non-zero if a required tenant table has RLS disabled.
- `scripts/ci/tenant-scope-audit.ts` exits non-zero for an ungated tenant query.
- The tenant-scope allowlist exists and every entry has a human-readable justification.
- A guarded cross-tenant integration test seeds at least two accounts and asserts no cross-account leakage on representative routes/helpers.
- `docs/security/rls-inventory.md` and `docs/security/tenant-isolation.md` exist and explain service-role versus RLS enforcement accurately.
- `.github/workflows/ci.yml` runs the secret-free parts of the audit. DB-backed parts are documented as staging-gated until `TEST_DATABASE_POOL_URL` exists in CI.

### Risks

- Static SQL scanning can be noisy. The mitigation is to keep the scanner narrow, reviewed, and allowlisted rather than pretending it is a full SQL parser.
- A skip-if-no-DB integration test does not block CI yet. The mitigation is to keep a separate hard-gate command documented and wire it once the DB-backed CI keystone lands.

## Slice 2: Billing And Invoice Reconciliation

Source specs:

- `docs/sass_ready/05-billing-subscription.md`.
- `docs/sass_ready/29-repworth-specific-gaps.md` Gap 2.

### Current Repo Anchors

- Stripe webhook handlers: `worker/ingress/stripe/*.ts`.
- Existing location-count reconciliation: `worker/background/pollers/StripeLocationsReconcilePoller.ts`.
- Step 1 `past_due_at` migration: `supabase/migrations/043_step_1_keystones.sql`.
- Subscription guard: `src/lib/shared/subscription-guard.ts`.
- Tier and overage config: `src/lib/accounts/tier-config.ts`, `src/lib/accounts/quota.ts`.
- Audit helper: `src/lib/audit/log.ts`.

### Design

Extend the existing reconciliation model rather than creating a parallel billing system.

`StripeLocationsReconcilePoller` already compares active DB location count with Stripe overage quantity. Wave 1 adds two capabilities:

1. Subscription-level reconciliation:
   - DB account has Stripe subscription, but Stripe subscription is missing, canceled, duplicated, or mismatched.
   - Stripe subscription status and DB `accounts.subscription_status` disagree.
   - Stripe subscription price or expected tier mapping disagrees with DB tier.

2. Upcoming-invoice reconciliation for multi-location accounts:
   - Calls Stripe upcoming-invoice APIs for accounts with multi-location billing.
   - Computes DB-expected base and overage lines from the same point-in-time billing snapshot rules used by the app.
   - Alerts when expected invoice total differs from Stripe by more than `$0.01`.

Expected-invoice math must respect billing grandfathering:

- Overage quantity: `computeOverageQuantity(activeLocations, accounts.locations_included)`.
- Overage unit price: `accounts.locations_overage_price_cents`, not `TIER_CONFIG[tier].overageCents`.
- Base price: `TIER_CONFIG[tier].baseCents` for now, because base price is the documented exception and is not currently stored/grandfathered.
- Prefer using `currentBillingSnapshot()` or a shared helper with the same semantics instead of rebuilding this logic inside the poller.

The poller can remain in `StripeLocationsReconcilePoller.ts` if the implementation stays cohesive. If it becomes too broad, split into focused modules under `worker/background/pollers/billing-reconciliation/` while keeping a single registered poller entry point.

Drift classification:

- Unsafe drift, alert via Sentry warning/error and manual investigation:
  - Missing Stripe subscription for a paid DB account.
  - Duplicate active Stripe subscriptions for one account.
  - Price ID or tier mismatch.
  - Quantity mismatch.
  - Upcoming invoice delta greater than `$0.01`.
  - Unknown Stripe state.
  - Stripe-vs-DB subscription status mismatch outside expected transition windows.

- Informational drift:
  - Metadata mismatch.
  - Timestamp-only mismatch.
  - DB `past_due` during the 7-day grace interval measured from `accounts.past_due_at`, when Stripe also reflects a payment-failure or past-due state.
  - Short webhook-processing windows where Stripe has changed state but the corresponding webhook has not yet reached RepWorth.
  - Accounts explicitly excluded by launch/pilot flag.

Pilot process:

- Use `accounts.flags.is_pilot = true` for the first multi-location accounts requiring manual invoice review.
- No new column is needed.
- Founder review records live in `docs/finance/pilot-invoice-review-YYYY-MM.md`.

### Acceptance Criteria

- Billing reconciliation runs hourly and emits a heartbeat log line.
- Missing, duplicate, price, quantity, and upcoming-invoice drift cases have focused tests.
- Upcoming invoice comparison alerts on a delta greater than `$0.01`.
- Pilot accounts are represented by `accounts.flags.is_pilot`, not a schema column.
- No new Stripe event dedup table is introduced; existing `inbound_events` remains the dedup model.
- Reconciliation does not auto-correct unsafe billing drift.

### Risks

- Stripe upcoming invoice APIs can be slow or rate-limited. The mitigation is single-flight execution, per-account error isolation, and one-hour cadence.
- Incorrect expected-invoice calculation can create false alarms. The mitigation is to reuse the current billing snapshot semantics: stored `accounts.locations_included`, stored `accounts.locations_overage_price_cents`, and live `TIER_CONFIG.baseCents` only for the documented non-grandfathered base-price exception.

## Slice 3: Security Launch Controls

Source spec: `docs/sass_ready/09-security-compliance.md`.

### Current Repo Anchors

- Security headers: `next.config.mjs`.
- Sentry scrubber: `src/lib/shared/sentry-scrub.ts`.
- Rate limiting: `src/lib/shared/rate-limit.ts`.
- Zernio ingress and ingest jobs: `worker/ingress/zernio/*`, `worker/jobs/zernio/*`.
- Existing Dependabot config: `.github/dependabot.yml`.
- CI base gate: `.github/workflows/ci.yml`.

### Design

Wave 1 security controls should focus on public disclosure, secret hygiene, dependency/scanning visibility, CSP hardening preparation, and PHI blocking before persistence.

Add public security surfaces:

- `public/.well-known/security.txt` with `Contact`, `Policy`, `Preferred-Languages`, and `Canonical`.
- Static `/security` page describing vulnerability disclosure, safe harbor scope, contact, data handling summary, and links to legal pages.

Add security process docs:

- `docs/security/vendor-risk-register.md`.
- `docs/security/access-checklist.md`.
- `docs/runbooks/secrets-rotation-stripe.md`.
- `docs/runbooks/secrets-rotation-supabase.md`.
- `docs/runbooks/secrets-rotation-zernio.md`.
- `docs/runbooks/secrets-rotation-email-and-messaging.md`.
- `docs/runbooks/secrets-rotation-api-keys.md`.

Add CI/security gates:

- Keep existing Dependabot grouping and ensure the Wave 1 spec does not claim auto-merge unless configured in GitHub.
- Add secret-free package/dependency audit commands where the current package manager supports them reliably.
- Add `docs/runbooks/security-scan-staging.md` with the exact ZAP baseline command, required staging URL secret, expected exit-code policy, and promotion path into CI.
- Do not add ZAP as a default CI hard gate in Wave 1 because the repo does not yet expose a stable staging target to secret-free CI.
- Do not add Trivy container scanning as a hard gate in Wave 1 because the repo does not currently have a Dockerfile/image to scan.

Add CSP hardening plan:

- Current `next.config.mjs` production CSP allows `'unsafe-inline'`.
- Wave 1 should introduce a nonce/report-only plan before enforcement.
- Per-request nonces cannot be generated by the current static `next.config.mjs` `headers()` function. The implementation plan should inventory inline scripts/styles and design a Next.js middleware/proxy-based nonce path before enforcement.
- `style-src 'unsafe-inline'` is expected to be harder to remove than `script-src 'unsafe-inline'`; report-only telemetry must distinguish style violations from script violations.
- The CSP inventory should also account for browser-side Google Maps / Places origins used by `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
- Enforcement happens only after report-only telemetry has been reviewed.

Add PHI scanner:

- Create a small shared scanner module for likely PHI patterns.
- Integrate it in every Zernio review-text ingest path before persistence: webhook/backfill/recent-poller unanswered reviews before `processReview`, and external-reply import before `insertImportedReview`.
- Detection should block ingest for the affected review, alert through Sentry, and avoid logging the raw PHI text.
- For webhook-delivered Zernio events, PHI detection is a terminal handled condition: the corresponding `inbound_events` row must be marked `processed`, the review must be quarantined or alerted for operator review, and the worker must not throw in a way that causes retry storms.
- For backfill/poller-driven ingest without an inbound webhook row, PHI detection must still be terminal for that review item and must not repeatedly retry the same blocked content.
- Patterns should include MRN-like identifiers, patient phrases, diagnosis/treatment phrasing, and insurance/member identifiers.
- The scanner is intentionally conservative and does not claim HIPAA compliance by itself.

### Acceptance Criteria

- `/.well-known/security.txt` and `/security` are present.
- Security docs and secrets-rotation runbooks exist for live vendors/secrets.
- CI has added only reliable, secret-free security gates by default.
- Staging-dependent ZAP or equivalent scanning is documented with the required secrets and target URL.
- CSP report-only/nonce rollout plan exists and does not remove `'unsafe-inline'` without a measured rollout.
- PHI scanner tests prove likely PHI blocks before review persistence, alerts without raw text leakage, and terminates processing without webhook or worker retry storms.

### Risks

- Public pages can overclaim security maturity. The mitigation is copy that states current status plainly, such as "SOC 2 not yet audited" when that is the actual status.
- PHI scanner false positives can drop legitimate reviews. The mitigation is to quarantine/block with alert and operator review rather than silently delete.

## Slice 4: Legal And Compliance Accuracy

Source spec: `docs/sass_ready/17-legal-compliance-docs.md`.

### Current Repo Anchors

- Existing docs: `docs/legal/repworth-privacy-policy.md`, `docs/legal/repworth-terms-of-service.md`.
- Current routes: `src/app/(public)/privacy/page.tsx`, `src/app/(public)/terms/page.tsx`.
- Public approval UI: `src/components/approval/approval-client.tsx`, `src/app/(public)/approve/[token]/page.tsx`.
- In-app approval/edit UI: `src/components/dashboard/EditReplyDrawer.tsx`.

### Design

Wave 1 legal work is about accurate, versioned, route-backed claims. Legal review and insurance are external gates, but the repo should make them operationally trackable.

Canonical legal routing:

- Move Terms to `/legal/terms`.
- Move Privacy Policy to `/legal/privacy`.
- Add `/legal/aup`.
- Add `/legal/dpa`.
- Add `/legal/cookies`.
- Add `/legal/sub-processors`.
- Add 301 redirects from `/terms` to `/legal/terms` and `/privacy` to `/legal/privacy`.

Legal content model:

- Keep source documents version-controlled under `docs/legal/`.
- Add `effective_date` and `version` metadata to each document source.
- Use a typed legal content module as the route source of truth for Wave 1. Current legal pages are hardcoded JSX and no MD/MDX pipeline exists; adding MDX is unnecessary for this launch-risk slice.
- Update `docs/legal/*.md` to mirror the published content and metadata, but do not make Markdown parsing a runtime dependency in Wave 1.

Sub-processor accuracy:

- Publish only vendors currently in the data path.
- Mark planned vendors as not listed until integrated.
- Correct Zernio data-class language: Zernio holds GBP OAuth tokens and review data; RepWorth stores a server-side Zernio API key and calls Zernio.
- Include OpenAI, Anthropic, Stripe, Supabase, Vercel, Railway, Upstash, Resend, Twilio, Telegram, Zernio, Sentry, SerpAPI, and Google Maps Platform.
- Include PostHog only after confirming `POSTHOG_API_KEY` is enabled in production and events are flowing to PostHog Cloud.
- Exclude Help Scout, Cloudflare, Loops, Customer.io, and other non-live vendors unless implementation verifies they are live.

AI disclosure:

- Public approval surface: add a clear banner near the draft response in `src/components/approval/approval-client.tsx`: "Draft generated by AI. Review carefully before approving."
- In-app edit/approval surface: add equivalent disclosure in `src/components/dashboard/EditReplyDrawer.tsx` when previewing generated drafts or approving updated replies.
- The disclosure is to the SMB owner at the approval moment. The posted Google response remains owner-approved speech and does not need an AI label in the posted text.

Versioning boundary:

- Add `effective_date` and `version` metadata to legal documents in Wave 1.
- Do not add `legal_acceptances` in this wave. The table, re-accept modal, and login-blocking acceptance flow move to a later legal-hardening slice so Wave 1 stays focused on public accuracy, approval evidence, tenant isolation, and billing reconciliation.
- The later legal-acceptance slice should use the next free migration number at that time and should record `user_id`, `account_id`, `doc_slug`, `version`, `accepted_at`, `ip`, and `user_agent`.

External gates:

- Lawyer review is an acceptance criterion that requires a human/legal vendor.
- Insurance binding is an acceptance criterion that requires founder/vendor action.
- The implementation should record external status in `docs/legal/insurance.md` and `docs/legal/legal-review.md`.

### Acceptance Criteria

- `/legal/terms`, `/legal/privacy`, `/legal/aup`, `/legal/dpa`, `/legal/cookies`, and `/legal/sub-processors` exist.
- `/terms` and `/privacy` redirect permanently to their `/legal/*` equivalents.
- Sub-processor list matches live vendor reality and does not include rejected or not-yet-integrated vendors.
- AI disclosure is visible at public and in-app approval moments.
- Legal documents are versioned and have effective dates.
- External legal review and insurance status are recorded in repo docs without falsely claiming completion before they happen.

### Risks

- Legal docs can become stale. The mitigation is version metadata, review cadence, and explicit external status docs.
- Deferring legal acceptance logging means Wave 1 will not prove user re-acceptance after material doc changes. The mitigation is to keep version metadata in Wave 1 and schedule a separate legal-acceptance slice before any material post-launch legal update.

## Slice 5: RepWorth-Specific Approval And Invoice Evidence

Source spec: `docs/sass_ready/29-repworth-specific-gaps.md` Gap 1 and Gap 2.

### Current Repo Anchors

- Approval audit writer: `src/lib/approval/audit.ts`.
- Approval token flow: `src/lib/approval/token-mode.ts`.
- Approval callback flow: `src/lib/approval/callback-mode.ts`.
- Approval route wrappers: `src/app/api/approve/[token]/*`.
- Public approval client: `src/components/approval/approval-client.tsx`.
- Existing approval audit table: `supabase/migrations/001_initial_schema.sql`, `002_prompt2_fixes.sql`, `014_retention_expansion.sql`, `034_multi_location_schema.sql`.
- Existing response approved text: `responses.approved_text`.

### Design

Gap 1 is about dispute defensibility: the immutable audit row must contain the exact text the owner approved.

Add a migration, expected as `044_approval_audit_snapshot.sql` unless another migration lands first:

- `approval_audit_log.response_text_at_approval TEXT`.
- `approval_audit_log.response_html_at_approval TEXT` only if implementation identifies a canonical HTML rendering. If no canonical HTML exists, omit it and document that text is the canonical approved artifact.
- Comment on the column explaining it is an immutable snapshot of owner-approved content.
- Add no new index unless implementation introduces a query that needs it.

Update approval audit write path:

- Extend `insertAuditLog` and `insertAuditLogSession` to accept an optional content snapshot object.
- Token-mode `approve` writes `response_text_at_approval = response_text` after locking the response and before/while updating `approved_text`.
- Token-mode `edit` writes `response_text_at_approval = sanitizedText`.
- Callback-mode `approveViaCallback` writes `response_text_at_approval = response.response_text` through the same snapshot-capable `insertAuditLog` call. It currently lives outside the `/api/approve/[token]/*` route wrappers and is invoked by channel ingress, so it must be updated explicitly.
- Session approval paths should use the same audit helper so all approval modes are covered.
- Regeneration and session establishment do not need content snapshots unless they approve content.
- The audit write remains in the same transaction as response status mutation and outbox enqueue.

Gap 2 is invoice correctness and is implemented in Slice 2. Slice 5 owns the business acceptance layer:

- Pilot invoice review docs.
- Manual review status for first multi-location customers.
- Clear launch gate: no multi-location paid customer launches without one successful reconciliation cycle and one recorded invoice review.

### Acceptance Criteria

- `approval_audit_log` stores `response_text_at_approval` for approve-as-is and edit approvals.
- Tests prove snapshot text equals what the owner approved.
- Tests prove later mutation of `responses.approved_text` does not change the audit snapshot.
- All approval modes that can publish content write through the snapshot-capable audit path.
- The invoice-reconciliation launch gate requires a clean reconciliation cycle and pilot invoice review for first multi-location accounts.

### Risks

- Capturing the snapshot before sanitization or final mutation can preserve the wrong text. The mitigation is to source the snapshot from the same value used for `responses.approved_text`.
- Adding HTML snapshot without canonical rendering can create inconsistent evidence. The mitigation is to store text first and add HTML only when canonical rendering exists.

## Data Flow

### Approval Snapshot

1. Owner approves or edits a draft response.
2. The approval flow verifies device/session and locks the pending response.
3. The flow computes the final approved text.
4. The response row is updated and publish outbox row is inserted.
5. `approval_audit_log` is inserted in the same transaction with `response_text_at_approval`.
6. If any step fails, the transaction rolls back and no partial evidence row exists.

### Billing Reconciliation

1. Hourly poller selects paid accounts with Stripe subscription IDs.
2. It computes expected subscription tier and location overage from DB.
3. It retrieves Stripe subscription and upcoming invoice.
4. It classifies drift.
5. Unsafe drift emits Sentry alert and log context.
6. Pilot account invoice reviews are recorded under `docs/finance/`.

### Tenant Isolation

1. Static tenant-scope audit scans code before merge.
2. RLS audit validates DB policy coverage.
3. Cross-tenant integration tests seed account A and account B.
4. Tests exercise representative app routes/helpers as account A.
5. Any account B row in account A results fails the test.

### PHI Blocking

1. Zernio review ingest receives normalized review data.
2. PHI scanner evaluates review text before `processReview` or `insertImportedReview`.
3. Likely PHI blocks persistence for that review.
4. Sentry/log alert records redacted context.
5. Operator review decides customer/account action.

## Error Handling

- Approval snapshot failures are strict. If the snapshot cannot be written, approval and outbox enqueue fail together.
- Billing reconciliation failures are isolated per account. One Stripe/API failure should not stop the whole poller.
- Tenant audit failures block merge.
- PHI scanner positive results block affected review persistence and alert. They do not stop unrelated reviews from ingesting.
- Public legal/security page rendering should fail build if required document metadata is missing.
- External gates cannot be automatically completed by code. The repo records status and evidence files instead.

## Testing Plan

### Unit And Component Tests

- `src/lib/approval/__tests__/service.test.ts`: approve/edit snapshot behavior.
- `src/lib/approval/__tests__/approve-via-callback.test.ts`: callback approval snapshot behavior if callback can approve content.
- `src/components/approval/__tests__` or existing public approval tests: AI disclosure visible.
- `src/components/dashboard/__tests__` or existing drawer tests: in-app AI disclosure visible.
- `worker/jobs/zernio/__tests__`: PHI scanner blocks and redacts.
- `worker/background/pollers/__tests__`: reconciliation drift classifications.

### Migration Structure Tests

- Add migration structure tests for approval audit snapshot columns.

### CI/Script Tests

- Script tests for `rls-audit.ts` with mocked query results.
- Script tests for `tenant-scope-audit.ts` with fixture files containing good, bad, and allowlisted SQL.

### Integration Tests

- Cross-tenant integration test guarded by `TEST_DATABASE_POOL_URL`.
- Billing reconciliation tests should mock Stripe rather than calling the Stripe API.

### Verification Commands

Narrow commands should be selected during implementation planning, but final verification before claiming implementation complete should include:

- Relevant Vitest targets for approval, reconciliation, PHI scanner, legal/security pages, and scripts.
- `pnpm build`.

## Acceptance Criteria

Wave 1 is complete when all of these are true:

- Tenant isolation docs, RLS audit, tenant-scope audit, and guarded cross-tenant test exist.
- Tenant-scope allowlist changes require explicit justification.
- Billing reconciliation detects subscription, price, quantity, duplicate, missing, and upcoming-invoice drift.
- Multi-location invoice drift greater than `$0.01` alerts.
- Pilot invoice review process exists and is tied to `accounts.flags.is_pilot`.
- `approval_audit_log` stores immutable approved text snapshots.
- Approval snapshot tests cover approve-as-is and edited approval.
- `security.txt` and `/security` are live without overclaiming maturity.
- Security docs and secrets-rotation runbooks exist for live vendors.
- PHI scanner blocks likely PHI before review persistence and alerts without logging raw PHI.
- Canonical `/legal/*` routes exist and `/terms`/`/privacy` redirect.
- Sub-processor list matches live vendors and correct data classes.
- AI disclosure is visible at owner approval moments.
- External lawyer review and insurance status are recorded accurately as pending or complete.
- Focused tests and `pnpm build` pass.

## Explicit Deferrals

These remain outside Wave 1 even though they appear in the source specs:

- Past-due day-variant banner, modal, and route-level read-only UX.
- Branded dunning emails and cancellation survey.
- Stripe Tax enablement.
- Chargeback tabletop.
- GBP-direct fallback source.
- Zernio contract negotiation.
- LLM cost monthly rollup.
- CSV import template/client validation.
- Grant-extension support action.
- Full Trust Center.
- MFA and team membership.
- Support impersonation.
- Enterprise sales/legal automation.

## Open Implementation Notes

- Current migration head is `043`; approval audit snapshot likely claims `044`, but implementation must check for new migrations first.
- `legal_acceptances` is explicitly deferred from Wave 1; do not add it in the Wave 1 implementation branch.
- Do not introduce a repository layer for tenant scoping.
- Do not introduce a new Stripe dedup table; use existing `inbound_events`.
- Do not claim ZAP, Trivy, Snyk, lawyer review, SOC 2, or insurance are complete unless the corresponding tool/vendor evidence exists.
- Do not persist raw approval tokens, PHI snippets, or customer secrets in logs, audit payloads, or outbox payloads.

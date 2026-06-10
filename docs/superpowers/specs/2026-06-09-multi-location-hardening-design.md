# Multi-Location Hardening — Design Spec

- **Date:** 2026-06-09
- **Status:** Approved (design walkthrough, sections 1–3)
- **Source:** Five-dimension multi-location code review (billing/quota, location lifecycle, settings/mode resolution, dashboard scoping + pipeline, cross-feature consistency + E2E testability), 2026-06-09.
- **Goal:** Make the multi-location feature launch-safe. The security/tenant-isolation core passed review; this spec fixes the lifecycle-edge, billing-recovery, and settings-scoping defects it found, and adds the E2E infrastructure needed to verify the feature without a real Google Business Profile account.

## Scope decisions (locked with owner)

| Decision | Choice |
|---|---|
| Spec scope | Launch-gating set: the 7 pre-launch fixes + price-change guard + full E2E kit. Fast-follow items (cost ceilings, LocationContext prop sync, `placeIdVerified` trust, offboarding Zernio-snapshot leaks, aggregate-view accuracy nits, doc drift) are explicitly **out of scope** — separate later spec. |
| Digest toggle ownership | Account-level. The fact moves to `accounts`; UI copy already says account-level. |
| E2E depth | Seeder + two-location Playwright spec + fake Zernio fixture server (full-loop local verification). |
| Implementation approach | Hybrid: surgical SQL predicates where the defect is a missing filter (the query owns its predicate); shared-module extraction **only** where the review found proven duplication (`findOverageItem` ×3) or an invariant needing one owner (exactly-one-primary repair in the existing tx modules). No pre-launch centralization of the ingest path. |

---

## Section 1 — Pipeline & lifecycle fixes

### Fix 1: Archived-location spend leak

Archived locations keep their Zernio connection active (intentional, for reactivation backfill) but today keep ingesting reviews and generating paid LLM drafts. Three layered gates, all **skip-as-success** (a skip never flips a job to failed):

1. **Webhook fan-out** — `worker/ingress/zernio/zernio.ts` (both the `review.new` and `review.updated` INSERT…SELECT): add `JOIN businesses b ON b.id = zc.business_id AND b.archived_at IS NULL`. Primary fix; archived locations stop producing ingest jobs at the source. (Asymmetry note: `ZernioRecentReviewPoller.ts` already filters `archived_at IS NULL`; this makes the webhook lane match.)
2. **Ingest worker guard** — `worker/jobs/zernio/ZernioReviewIngestWorker.ts` step 1: the existing subscription query already joins `businesses`; select `archived_at` and complete-as-skip (structured log reason `archived_location`) when set. Catches jobs already queued at deploy time.
3. **Generator gate** — `worker/jobs/response-generation/load-context.ts`: select `archived_at`; archived → terminal skip. Defense for backfill/update lanes and directly-enqueued jobs.

**Ops note (one-off, not code):** after PR A deploys, run a SQL sweep to count and expire `pending_approval` drafts already accumulated for archived locations.

### Fix 2: Exactly-one-primary invariant

The index `businesses_account_primary_uniq` enforces *at most* one primary; two reachable paths produce *zero* primaries, and promote-primary refuses to repair that state.

1. **Race-proof archive (owner path)** — `src/lib/locations/archive-location-tx.ts`: add `AND is_primary = FALSE` to the archive UPDATE predicate; 0 rows updated → throw `promote_first` (same error code the pre-tx guard uses, now enforced under the lock). The offboarding-teardown variant (`archiveLocationForAccountOffboardingTeardownTransaction`) keeps its current behavior — archiving the primary there is intentional.
2. **Promote becomes the repair path** — `src/lib/locations/promote-primary-tx.ts`: demoting 0 rows is no longer an error. A zero-primary account can always be fixed by promoting any active location.
3. **Reactivation self-heals** — `reactivateLocationTransaction`: if the account has no active primary after reactivation, promote the reactivated location to primary **in the same transaction**. Heals the offboarding-cancel → reactivate flow automatically.

### Fix 7: Server-side duplicate `google_place_id` enforcement

Duplicate prevention is currently client-side only; a duplicate location double-ingests every review (double LLM spend, double notifications).

1. **Migration** — partial unique index:
   `CREATE UNIQUE INDEX businesses_account_place_uniq ON businesses (account_id, google_place_id) WHERE archived_at IS NULL AND google_place_id IS NOT NULL;`
   Follow the migrations-log conventions (next number from the log; staging first, both Supabase projects in lockstep).
2. **Pre-flight check (before the migration runs anywhere):** a read-only query that lists active duplicate `(account_id, google_place_id)` pairs, run against staging **and** prod. The migration is blocked until the result is empty (manual dedup if not).
3. **Error mapping** — `addLocationTransaction`, `reactivateLocationTransaction`, and the admin CSV import catch Postgres error `23505` on this constraint → typed `duplicate_location` error → HTTP 409 on `/api/locations/add` and `/api/locations/reactivate`; per-row error in the CSV import report. CSV import additionally rejects in-file duplicate place IDs before processing any row.
4. No `ON CONFLICT` clauses are added (we only catch the error code), so the byte-for-byte partial-index-predicate gotcha does not apply.

---

## Section 2 — Billing repair layer & settings scoping

### Fix 3: Overage recompute on subscription recovery

`UpdateStripeOverageWorker` correctly no-ops while a subscription is non-active, but nothing recomputes when it recovers — archive-during-`past_due` overbills forever.

1. **Recovery enqueues** — inside the existing `past_due → active` recovery transaction in `worker/ingress/stripe/invoice-paid.ts`, insert an `update_stripe_overage_quantity` outbox row (deterministic outbox key per existing convention). Same enqueue in the `checkout-completed` past_due-reactivation branch. The worker recomputes quantity from the committed location count, so the enqueue is a cheap idempotent convergence step.
2. **Outbox semantics on transient Stripe errors** — `worker/jobs/billing/UpdateStripeOverageWorker.ts` currently calls `markOutboxFailed` on the first error, forfeiting the 1h watchdog. New classification, mirroring the cost-guard convention from PR #255:
   - **Transient → re-throw without touching the outbox row** (stays `dispatched`; BullMQ retries, watchdog re-dispatches): `StripeConnectionError`, `StripeAPIError`, `StripeRateLimitError`, any 5xx.
   - **Terminal → `markOutboxFailed`**: account not found, unknown tier, missing price env, `StripeInvalidRequestError`, `StripeAuthenticationError`.

### Price-change guard: one shared `findOverageItem` (subsumes pre-launch Fix 4)

This section also delivers review Fix 4 — the tier-change route's any-non-base-item fallback that could delete or re-price an arbitrary subscription item — as the third consumer below.

Three divergent implementations of “find the overage subscription item” guarantee the worker and the reconcile poller disagree the first time an overage Price is rotated (the worker would create a **second** overage item → double-billing).

1. **New module** `src/lib/payments/overage-item.ts` exporting `findOverageItem(items, { overagePriceIds, storedOveragePriceCents })`, extracted from the reconcile poller's tolerant heuristic: env price-ID set → `lookup_key`/`nickname`/`metadata` match → unit-amount match against the account's **stored** `locations_overage_price_cents`.
2. **Three consumers converge:**
   - `billing-reconciliation/stripe-overage.ts` (poller): behavior-preserving swap.
   - `UpdateStripeOverageWorker`: replaces the env-set-only lookup. When the matched item carries a legacy price, **update quantity on the legacy item at its legacy price** (true grandfathering). Create a new item only when nothing matches.
   - `src/app/api/billing/tier-change/route.ts`: replaces the any-non-base-item fallback. No match → **touch nothing** (never delete/re-price an unmatched item); reconciliation alerts on residual drift. Additionally, a missing overage price env for the target tier becomes a hard error **before any Stripe mutation** (today the base price is swapped first, then the overage step silently no-ops).

### Fix 5: Digests become account-level

The weekly-summary / monthly-impact toggles are presented as account-level, stored per-location, written only to the primary row, and read per-location by the schedulers — secondary locations can never be opted out, and archived locations keep emailing digests.

1. **Migration** — `accounts.weekly_summary_enabled BOOLEAN NOT NULL` and `accounts.monthly_impact_enabled BOOLEAN NOT NULL`, backfilled per account from its primary business row (`COALESCE(b.<column>, TRUE)`), default `TRUE`. Accounts with no active primary row (e.g. fully archived after cancellation-grace expiry) backfill to `TRUE`.
2. **Write path** — `PUT /api/settings` writes the two account columns instead of the business columns for these fields.
3. **Read path** — `worker/background/schedulers/WeeklySummaryScheduler.ts` and `MonthlyImpactScheduler.ts` join `accounts` and evaluate the account columns; both queries also gain `AND b.archived_at IS NULL`. The shared skip helper in `worker/jobs/summary-report-helpers.ts` gets an archived check (defense for already-queued jobs).
4. **Deprecation, not deletion** — the per-business columns stop being read but are not dropped in this spec (cleanup migration later).
5. **Out of scope:** the contact-phone field stays per-location — no per-location consumer reads it, so it has no scoping defect.

### Fix 6: Channel overrides stay visible and cascade on disconnect

Per-location channel overrides outlive multi-location mode (archive back to 1 location → override keeps routing notifications with no UI to manage it), and disconnecting an org-default channel leaves override clones live.

1. **Visibility** — `ChannelsTabClient.tsx`: render existing overrides (list + delete) whenever `perLocationOverrides.length > 0`, regardless of mode. Override **creation** stays gated on multi-location mode, as today. `settings/channels/page.tsx` includes archived locations in the location-name map with an “(archived)” suffix (also fixes the raw-UUID display).
2. **Disconnect cascade** — `disableTelegramEnrollment` / `disableWhatsAppEnrollment` (`src/lib/channels/*-enrollment.ts`): in the same transaction as the org-default disable, disable all per-location override rows for that `account_id` + channel, with `writeAccountAuditLog` in-tx; per-location notification-cache invalidation after commit.
3. **Atomicity** — `src/app/api/settings/channels/override/route.ts` create/delete: enrollment write + `writeAccountAuditLog` in one `sql.begin()` (replacing the raw `INSERT INTO account_audit_log` outside any tx); cache invalidation post-commit.

---

## Section 3 — E2E verification kit (no GBP required)

`MOCK_EXTERNAL_APIS=true` cannot run the full loop (the ingest worker short-circuits in mock mode), and current Playwright coverage of multi-location is effectively zero.

1. **Seeder** — `e2e/seed.ts` gains `seedMultiLocationAccount`: one `accounts` row (standard tier with `locations_included` / `locations_overage_price_cents` / `base_price_cents` snapshot per invariant #9a), two `businesses` (primary + secondary, distinct `google_place_id`s, display labels), two `zernio_connections` with distinct `zernio_location_id`s, owner user, org-default channel enrollment. Same graceful-skip contract as the existing seeders.
2. **Playwright spec** — new `e2e/multi-location.spec.ts`: location switcher shows both locations; per-location scoping of dashboard and past-replies; settings tabs render the multi-location set; archive flow (location leaves the switcher; archiving the primary is blocked); promote-primary; add-location wizard eligibility gate. Skips without `TEST_DATABASE_POOL_URL`.
3. **Fake Zernio fixture server** — `e2e/fixtures/zernio-fixture-server.ts`: a small Node HTTP server implementing `list_locations` (configurable count), `list_reviews` per `zernio_location_id` (seedable via a control endpoint), `publish_reply`, `delete_reply`. Full-loop procedure: run the local stack with `MOCK_EXTERNAL_APIS=false` and `ZERNIO_API_BASE` pointed at the fixture server; fire signed per-location webhooks with the existing `scripts/zernio-fire-webhook.sh`; the entire ingest → draft → notify → approve → publish loop runs for two locations. Use real LLM keys with a low `GLOBAL_DAILY_COST_LIMIT_CENTS` (pennies on gpt-4o-mini). Documented as a new runbook section under `docs/runbooks/`; manual pre-launch procedure, **not CI**.
4. **Mock transport** — parameterize the hardcoded single location: `MOCK_ZERNIO_LOCATION_COUNT` (default 1) so the mocked connect flow can simulate two locations. The ingest mock short-circuit stays as-is — the fixture server is the full-loop path, so the short-circuit no longer needs replacing.
5. **What stays untestable without a real GBP** (accepted): real Google-side reply visibility/propagation, the real OAuth consent + multi-location picker, Google permission/rate error shapes, verify-posted against eventually-consistent Google data. These remain on the “one careful first post in production” discipline in the deployment guide.

---

## Delivery plan

Six PRs, ordered by risk retired. Everything touching the worker or a migration rides `staging` first, then lands on `main` via PR with CI green; `staging` fast-forwards onto `main` after each promotion. Migrations apply to both Supabase projects in lockstep, staging first.

| PR | Contents | Notes |
|---|---|---|
| **A** | Fix 1 (spend-leak predicates) + the scheduler `archived_at` filters from Fix 5.3 | Worker-only; lands first — stops the active cost leak. |
| **B** | Fix 2 (primary invariant) | Parallel with C after A. |
| **C** | Fix 7 (duplicate place_id migration + 23505 mapping) | Pre-flight dupe check on staging **and** prod data before the migration. |
| **D** | Fix 3 + price-change guard (recovery enqueues, shared `findOverageItem` + three consumers, transient-error outbox semantics) | |
| **E** | Fix 5 remainder (accounts migration, settings write path, scheduler reads) + Fix 6 (override visibility, disconnect cascade, route atomicity) | |
| **F** | E2E kit (seeder, Playwright spec, fixture server, mock-transport param) + runbook section | Run the full-loop verification before launch sign-off. |

## Testing strategy

Every fix originates from a human-found defect → each gets a regression test pinning the contract:

- Fan-out excludes archived locations (SQL-level integration test on the fan-out INSERT…SELECT); ingest-worker and generator skip archived (skip-as-success asserted).
- Archive-of-just-promoted-location fails under the lock (tx-level race test); promote with zero current primaries succeeds; reactivate into a zero-primary account self-promotes.
- 23505 → `duplicate_location` → 409 on add and reactivate; CSV in-file duplicate rejection; CSV per-row duplicate report.
- `past_due → active` recovery tx inserts the recompute outbox row (invoice-paid and checkout-completed variants).
- `findOverageItem` against legacy/rotated price IDs — for **all three consumers** (the worker test that was missing); worker updates the legacy item instead of creating a duplicate; tier-change with no matched overage item touches nothing; tier-change hard-fails on missing target-tier overage env **before** the base mutation.
- Transient Stripe error leaves the outbox row `dispatched`; terminal errors mark it failed.
- Schedulers read account columns and skip archived locations; settings PUT writes `accounts`.
- Override list renders in single-location mode when overrides exist; creation gated on mode; org-default disconnect disables override rows in the same tx with an audit row.

Per PR: `pnpm lint && pnpm typecheck && pnpm test`. DB-touching PRs (C, E) additionally run `pnpm ci:tenant-scope && pnpm ci:rls-audit`. PR F's Playwright spec runs via `pnpm test:e2e` with `TEST_DATABASE_POOL_URL` set.

## Error-handling rules (cross-cutting)

- Pipeline gates (Fixes 1, archived checks) are **skip-as-success**: a skip completes the job with a structured log reason; it never flips completed work to failed and never burns a retry.
- The Stripe boundary distinguishes transient (retry via BullMQ + outbox watchdog) from terminal (mark failed) — never reclassify a business decision as infra, mirroring the cost-guard rules.
- Tier-change validates everything it needs (target-tier price envs, matched items) **before** the first Stripe mutation; partial-failure repair beyond that remains the reconcile poller's alert (full tier-change self-repair is out of scope — fast-follow).

## Out of scope (deferred to a fast-follow spec)

Account-level LLM cost ceilings (per-business daily caps scale linearly with location count); `LocationContext` prop re-sync; server-side `placeIdVerified` validation and URL-mode `validate_place_id` enqueue; offboarding Zernio-snapshot leaks (archived-location Zernio IDs excluded from teardown snapshot; connect-during-cancel-window escape); aggregate-view accuracy nits (`billingPending` index shift, sampled pending counts, status-literal duplication); auto-approval override warning on reactivation; migrations-log §5 doc drift; dropping the deprecated per-business digest columns.

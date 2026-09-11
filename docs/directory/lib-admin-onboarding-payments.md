## `src/lib/`

### `payments/`

| File | What it does |
|------|--------------|
| `price-tier-map.ts` | Single variant-aware owner of the four Copilot/Autopilot base Price IDs and two overage IDs; forward lookup takes `(tier, price_variant, kind)` and reverse base lookup returns `{tier, variant}`. |
| `create-checkout-session.ts` | Creates card-up-front monthly Stripe Checkout Sessions from one authoritative account attempt. Retries use its frozen Price/quantity/trial/tax/email/URL tuple under a stable idempotency key; promotion codes stay disabled. |
| `founding-window.ts` | Strict-UTC, fail-closed `FOUNDING_DEADLINE` eligibility (`now < deadline`). |
| `tier-purchasability.ts` | Composes the server-only Autopilot sales gate with auto-approval runtime readiness. |
| `plan-presentation.ts` | Server-produced Copilot/Autopilot availability and founding/list amount view model for pricing, onboarding, and billing UI. |
| `plan-activation.ts` / `overage-item.ts` | Complete stored billing-snapshot activation, single pending Checkout lease/reselection, and variant-aware overage item resolution. |
| `stripe-client.ts` | Shared pinned Stripe client with bounded timeout/retry policy. |
| `checkout-attempt.ts` | `CheckoutAttemptLeaseColumns` — the shared projection of the `accounts.checkout_attempt_*` lease columns — plus `CheckoutCouponDecisionReason` (`applied` / `not_invited` / `env_unset`) and `checkoutCouponDecisionLabel` for the beta comp coupon decision log (admin-invite-funnel step 11); `env_unset` is the one that means an invited tester is about to be charged. |
| `flags.ts` | Payments flag accessors over `readFlag`: `trialEnabled()`, `stripeTaxEnabled()`, `stripeLocationsReconcileDisabled()`, plus `betaCompCouponId()` — the trimmed `BETA_COMP_COUPON_ID` via `getServerConfig()` or null (unset = comp off); sole consumer is `resolveCheckoutCreateShape` in `plan-activation.ts`. |
| `stripe-error-inspect.ts` | Single owner of the STRIPE error-inspection vocabulary: `RETRYABLE_STRIPE_ERROR_TYPES`, `PERMANENT_STRIPE_ERROR_TYPES`, and `isStripeCouponError` (classifier only — `param` → `code` → `message`). The provider-agnostic half (`RETRYABLE_NETWORK_ERROR_CODES`, `errorStringProperty` / `errorNumberProperty`) moved to `shared/error-inspect.ts` (#913). Retry POLICY stays with the two consumers (`account-offboarding/stripe-invoices.ts`, `worker/jobs/billing/stripe-overage-error.ts`). |


### `admin/` *(Wave 2 additions)*

The generated Admin API contract and route-specific wire types live in
`docs/admin-api/`; the barrel below indexes existing service DTOs only.

Admin-side domain helpers.

> **Admin business query — rules the code does not make obvious** (moved here
> from the CLAUDE.md routing row on 2026-08-16; `docs/context/core-accounts-channels-admin.md` → **Business
> summary** + **At-risk list**, two LOCKED terms; spec
> `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §5).
> `business-summary.ts` is the SINGLE owner of the base query, the conditional
> COUNT, the metrics follow-up and `buildBusinessSummary`; it exports ONE
> function, `getBusinessSummaries(sql, opts?)` — Overview calls it unpaginated
> and ranks, Businesses calls it with a page. Do not re-spell that query in a
> second module (it was spelled twice until #833). (a) The at-risk list is
> **filtered THEN capped** — eligibility `churnScore.level !== 'healthy'`, then
> top `OVERVIEW_AT_RISK_LIMIT`; capping first surfaces healthy rows and is the
> bug the tests exist to catch. (b) Ranking is **TypeScript and must never become
> `ORDER BY … LIMIT`** — account age makes every business score non-zero, so no
> SQL predicate is a provable superset of "at risk", and Overview reading every
> row is a RECORDED limitation (§5.1) with a named rejected alternative, not an
> oversight. (c) Businesses fetches metrics for the **current page's ids only**
> (LIMIT/OFFSET first, then metrics) — a pinned test guards that bound. (d)
> `OVERVIEW_AT_RISK_LIMIT` lives in `overview-service.ts`, NOT `page-sizes.ts`
> as §5.1 asks, because `src/lib/**` may not import `@/app/**`
> (`APP_LEAF_IMPORT_BAN`) and nothing app-side reads it. Health presentation has
> ONE owner, `src/components/admin/ui/HealthBadge.tsx` — all three surfaces
> import it now, including the business DETAIL page, which carried a private
> `Record<string, string>` copy (an unrecognised level rendered silently green)
> until it was deleted; and churn DERIVATION has one owner too, which is
> `business-summary.ts` and NOT a third module — it exports
> `churnMetricsQuery(sql, businessIds)` + `churnScoreFromMetrics(row)`, and
> `business-detail/{queries,mappers}.ts` call them, the detail page passing a
> one-element id array instead of re-spelling the CTE.

| File | What it does |
|------|--------------|
| `api-contract.ts` | Type-only index of existing Admin API response DTOs consumed by the compiler-based contract generator; adds no types or runtime behavior. |
| `impersonation/cookie.ts` | HMAC signs/verifies the `rw_impersonation` session cookie. |
| `impersonation/session.ts` | Starts, ends, and loads active impersonation sessions with account audit logging. |
| `impersonation/view.ts` | Resolves an admin-owned impersonation view session and loads account-scoped location data. |
| `impersonation/guard.ts` | Non-destructive action allowlist for impersonation surfaces. |
| `shell-context.ts` | `loadAdminShellContext(sql, {supabase, signedImpersonationCookie})` — the admin shell's display facts: signed-in email + AAL2 state for the sidebar footer (X7) and the live view-as session (ISO expiry + account label) for the sticky banner (X25). Sequential reads, degrades to nulls, never redirects; read by `src/app/admin/layout.tsx`. |
| `nav-counts-service.ts` | `getAdminNavCounts(sql)` — the two cross-tenant aggregate COUNT queries (flagged_responses open, job_outbox failed) behind the sidebar's badge counts. Used by `GET /api/admin/nav-counts`. |
| `jobs-service.ts` | **(Phase 2)** `getAdminJobsData(sql, {limit, offset})` — the outbox status summary (incl. `dispatching`), a page of failed jobs, and the failed total. Used by `GET /api/admin/jobs`. |
| `queue-health.ts` | **(Phase 2)** `fetchQueueHealth()` — per-queue BullMQ depth + shared-pool wait, fetched from the Railway worker's authed internal endpoint; degrades to `{unavailable: true}` / `null` on any failure (missing config, non-200, timeout). Used by `GET /api/admin/jobs`. |
| `notifications-service.ts` | **(Phase 2)** `getAdminNotifications(sql, filters)` — the notification delivery log page (dynamic `sql.unsafe()` WHERE builder) + the businesses filter dropdown. Used by `GET /api/admin/notifications`. |
| `flagged-service.ts` | **(Phase 2)** `listOpenFlaggedResponses(sql, {limit, offset})` — a page of the open flagged-response queue (joined to response/review/business) + the open total. Used by `GET /api/admin/flagged` (the POST disposition transaction stays in the route). |
| `suppressions-service.ts` | **(#645)** The admin-owned Suppression ledger paths (spec §7.3, §8.2): `lookupSuppressions` (live rows for one **Normalized handle** + its prior corrections, so a re-entry after a correction is visible rather than a surprise — cross-tenant, `ci:tenant-scope`-allowlisted; since #662 it also `LEFT JOIN`s `users` to return `removedByUserLabel` as `Name (email)`, degrading to the raw `removedByUserId` when the row is gone — `CleanupAbandonedSignupsPoller` really does DELETE users, so that arm is reachable. That join carries NO allowlist entry and needs none: `users` is absent from `TENANT_TABLES`, so `ci:tenant-scope` forms no opinion about it — do not read the green audit as a review of it. It is safe on its shape, a bounded PK lookup of one actor row behind `requireAdminWithAal2` returning staff identity, never tenant data), `recordAdminManualSuppression` (`global` / `admin_manual`, `accountId` deliberately null — a mailbox reply names no account and guessing one writes false provenance), and `correctSuppression` — **one** data-modifying CTE whose `DELETE … RETURNING` feeds the `solicitation_suppression_corrections` INSERT, so the delete cannot commit without its audit record even if a call site forgets a transaction, and the record is built from the DELETE's own `RETURNING` so a concurrent correction cannot describe a row this call did not remove. Zero rows back = `'not_found'`: nothing deleted, no orphan record, no third outcome. Authorization lives in the callers (the two `requireAdminWithAal2` routes), which is the proof `recordSuppression`'s `createdByUserId` string cannot carry. |
| `business-summary.ts` | **(§5.2)** `getBusinessSummaries(sql, opts?: {limit, offset})` — the **one** owner of the admin business read both admin surfaces share, and the module that replaced `businesses-list-service.ts` (deleted) plus the duplicate base query in `overview-service.ts`. It owns: the **base query** — PAGE-FIRST since 2026-09: a `page` CTE takes `businesses` JOIN `accounts` with `ORDER BY b.name ASC, b.id ASC` and the `LIMIT/OFFSET` (only when `opts` is supplied), and only THEN is non-superseded `responses` LEFT JOINed and aggregated (pending-approval/pending-reconnect counts all-time, response aggregates windowed), so the response scan is bounded by the page's ids instead of the whole table; the **conditional unfiltered COUNT** — issued only on the paginated path, because an unpaginated caller already holds every row and gets `total = businesses.length` (deliberately not a window `COUNT(*) OVER ()`: the page query GROUPs, so a window total would count grouped page rows); the **metrics follow-up** (the churn-signal CTE) keyed on the ids the base query *actually returned* post-`LIMIT`, so `/admin/businesses` is bounded by its page and not by the table, and skipped entirely for an empty page; `buildBusinessSummary` (row→DTO + `computeChurnRiskScore`, carrying its `fallow-ignore-next-line complexity` marker); and `RESPONSE_METRICS_WINDOW_DAYS` (30) — the single owner of the trailing response-metrics window, surfaced as `responseMetricsWindowDays` so both pages' column labels derive from it instead of a literal `30`. Read by `/admin/overview` unpaginated (which then ranks in TS — see the **At-risk list**) and by `GET /api/admin/businesses` + `businesses/page.tsx` with a page; the limit/offset clamping stays in the route. Strictly sequential per #773 — rows → COUNT → metrics, never a `Promise.all` over `sql` — pinned by `__tests__/pool-fanout-sequential.test.ts`. |
| `business-summary-filters.ts` | The three PURE steps `getBusinessSummaries` runs around its statements, extracted so the query owner reads as resolve → filter → rows → count → metrics → score → cap: `resolveBusinessListParams(opts?)` (normalised `search`/`status`/`health` plus the one shaping decision — `sqlPage` when LIMIT/OFFSET can be taken in SQL, `healthPage` when a health filter forces every scored row to be read first, neither when unpaginated), `buildBusinessFilter(sql, {search, status})` (the single `WHERE …` fragment the page CTE and the COUNT both interpolate, `escapeLike` included, empty fragment when blank) and `capByHealth(scored, healthPage)` (filter on the scored level THEN slice the page — the At-risk rule, never the reverse). Issues no query and names no table; the statements stay in `business-summary.ts`, which remains the single owner. |
| `business-channels-service.ts` | **(Phase 3)** `getBusinessChannelEnrollments(sql, businessId)` — account resolution, the enrollment query, per-channel dedup (location override beats org default), and `maskChannelHandle`. All timestamps ISO. Single owner shared by `GET /api/admin/businesses/[id]/channels` and `businesses/[id]/page.tsx`. |
| `offboardings-service.ts` | **(Phase 3)** `getAdminOffboardings(sql, {limit, offset})` — the lifecycle list + count, the row mapper, and `scrubAdminLastError` (the security-relevant redactor). Exports the `AdminOffboarding`/`AdminProviderDisposition` DTOs the client imports. Single owner shared by `GET /api/admin/offboardings` and `offboardings/page.tsx`. |
| `demos-service.ts` | **(Phase 3)** `getAdminDemos(sql)` — the demo list read, ISO timestamps. Single owner shared by `GET /api/admin/demos` and `demos/page.tsx`. |
| `business-detail-service.ts`, `business-detail-types.ts`, `business-detail/{queries,mappers,update,errors}.ts` | The business-detail read/write model behind `GET`/`PATCH /api/admin/businesses/[id]` and `businesses/[id]/page.tsx`. The mappers own the `timestamptz → ISO string` conversion for every `string`-typed DTO field — a raw `Date` is invisible through a route's `JSON.stringify` but crosses the RSC boundary intact and throws on first paint. |
| `overview-service.ts` | **(§5.1/§5.3)** `getAdminOverview(sql)` — the 5 system-health queries (pending/failed `job_outbox`, today's API cost, 24h notification failures, the email-delivery aggregate), `deriveEmailHealth` (delivery rate + `redState`), and the **At-risk list** selection: `getBusinessSummaries(sql)` unpaginated as its 6th sequential await, then filter `churnScore.level !== 'healthy'` → sort (score desc → pending desc → name asc → id asc) → cap at `OVERVIEW_AT_RISK_LIMIT`. It no longer owns the business base query, the metrics CTE, `buildBusinessSummary` or a separate `COUNT` — those went to `business-summary.ts` — and it takes no `{limit, offset}`: Overview stopped paginating. It also **declares** `OVERVIEW_AT_RISK_LIMIT` (5) rather than `page-sizes.ts`, because the cap is applied here and `src/lib/**` may not import `@/app/**` (eslint `APP_LEAF_IMPORT_BAN`); reasoning in `docs/superpowers/plans/refactor-overview-spec-alignment-deviations.md`. |
| `cost-report-service.ts`, `margin-service.ts`, `csv-import.ts` | API-cost report; admin-only aggregate margin signals; the CSV locations-import row processor. |


### `onboarding/`

> **Admin invite funnel — rules the code does not make obvious** (moved here from
> the CLAUDE.md routing row on 2026-08-16; plan
> `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md`, `docs/context/admin-invite-funnel.md` →
> **Admin invite**, **Checkout attempt**, **Funnel entry**, **Beta comp coupon** —
> four LOCKED terms; staging proof
> `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md`; step-7
> reviews `docs/reviews/admin-invite-funnel/`).
> (a) **Every** Stripe Session parameter is built from the durable
> `accounts.checkout_attempt_*` snapshot, never a live env read — the coupon
> joined that snapshot precisely so an ops flip between an owner's first click
> and their retry cannot change the price under a key Stripe treats as
> identical. (b) `resolveFunnelEntry` (`funnel-entry.ts`) is **pure** — it takes
> `onboardingDemoEnabled()` as an argument and reads no flag, env or DB, which
> is what keeps flag state server-side (invariant #13) and the whole matrix
> table-testable; the deleted `paymentUrl` must not come back. (c) `onboarded_by`
> on the PRIMARY business is the comp's only eligibility marker and already
> carries three unrelated meanings — before reusing or widening it read the
> rejected-finding record in
> `docs/reviews/admin-invite-funnel/adversarial-approach-codex.md` (migration
> 025 backfilled it on every pre-025 row, and NULLing those rows would grant
> trial eligibility and strip a `CleanupAbandonedSignupsPoller` guard).
> **Migration 105 cannot be applied where 077 has not been** — a real
> dependency, but no longer a prod gate: both 077 and 105 are applied in prod as
> of 2026-08-14 (see the standing exception in CLAUDE.md § Environments).

| File | What it does |
|------|--------------|
| `create-business.ts` | `createBusinessTx(sql, params)` — atomic transaction that inserts `users` + `businesses` + `channel_enrollments` (email) rows. Used by both admin and self-serve signup. Dual mode (`admin` / `self_serve`). |
| `admin-onboarding-service.ts` | `onboardBusinessAsAdmin(sql, supabase, input)` — validates admin onboarding input, calls `createBusinessTx` in `admin` mode, handles `DuplicateEmailError`, and invites the owner via Supabase `inviteUserByEmail`. `rollbackProvisionedBusiness(sql, createdResult)` runs the shared FK-ordered 4-DELETE compensating rollback used by both failure paths. Used by `POST /api/admin/businesses`. **(2026-08-14)** Input is now only owner email, owner name and business name; it resolves no Place ID, writes no voice fields, asserts no tier (the row is created on the `copilot` default and the owner picks their real tier at `/onboarding/pay`), and enqueues no `validate_place_id` — `/api/onboarding/start` does that once the owner captures a place, exactly as it does for self-serve. |
| `funnel-entry.ts` | **(2026-08-14)** `resolveFunnelEntry(state)` — the single owner of "where in the funnel does this owner belong?", returning one of `/onboarding/{start,demo,pay,business}` or `/dashboard`. **Pure**: no DB handle, no `process.env`, no flag read (the caller passes `onboardingDemoEnabled()` in), so the whole matrix is table-testable and flag state stays server-side (invariant #13). Its output is the `funnelUrl` field on `GET /api/auth/signup-status`, `GET /api/dashboard` and `GET /api/settings`, consumed by `loginDestination` and `PendingPaymentScreen`. Replaced three disagreeing branches — `loginDestination`'s demo-blind `pending_payment → /onboarding/pay`, `verify-otp`'s private start-vs-pay branch, and the dashboard's hardcoded `paymentUrl` (that field is **gone**, not renamed). |
| `resend-invite.ts` | **(2026-08-14)** The re-invite decision + Supabase provider-error mapping behind `POST /api/admin/businesses/[id]/resend-invite`. Gates on account `pending_payment` AND the provider reporting `last_sign_in_at IS NULL`. ⚠️ **The error mapping is deliberately staging-unverified** — the module header carries a "staging-verify before prod" marker, an unknown provider error answers `502` with the raw provider code logged and is never auto-retried, and verifying the real Supabase re-invite error shapes on staging is an open ops step (`docs/runbooks/beta-onboarding-cofounder-guide.md` → Part 12). |
| `flags.ts` | `onboardingDemoEnabled()` — single owner of the `ONBOARDING_DEMO_ENABLED` flag (the pre-pay onboarding demo lane: start/business/demo pages + their routes), a one-line wrapper over `readFlag` in the `<feature>/flags.ts` convention. Server-authoritative (invariant #13) — no `NEXT_PUBLIC_*` companion; the browser learns the state via API responses/props. |

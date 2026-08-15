# Portal Audit Remediation (design spec)

_Status: approved design, pending implementation plan · 2026-08-15_
_Owner: Norbert + Claude · Branch: `docs/portal-audit-remediation-spec`_

## 1. Problem

A read of every page under `src/app/(authenticated)` and `src/app/admin` — 40
page files, 20 per portal — plus the four nav definitions surfaced one
user-facing bug, two latent bugs, three duplicated workflows, and two
convention violations. Static verification of the tree was
green throughout — `pnpm typecheck`, `pnpm lint`, and `pnpm test` (11,650 passed
/ 0 failed across 895 files) — so none of this is caught by CI today.

Findings, as confirmed against the tree:

| # | Finding | Class |
|---|---|---|
| 1 | Owner sign-out pushes to `/admin/login`, which rejects owner credentials | user-facing bug |
| 2 | `/admin/overview` duplicates `/admin/businesses`; Overview paginates in JS | duplicated workflow |
| 3 | 6 owner channel routes hand-roll the chain the admin side already extracted | duplicated workflow |
| 4 | Telegram deep-link fallback diverged between the two copies of finding 3 | latent bug |
| 5 | `/admin/businesses/[id]` reintroduces the fan-out its own service forbids | convention |
| 6 | `/settings/competitors` fan-out width grows with location count | scaling |
| 7 | Auto-approval threshold labels spelled twice | duplication |

### 1.1 Corrections to the original audit

Two claims from the first pass did not survive verification and are recorded
here so they are not re-raised:

- **`admin/jobs/page.tsx` `Promise.all` is not a defect.** It races one DB read
  against `fetchQueueHealth()`, which is an HTTP call to the Railway worker and
  takes no `sql` connection. `jobs-service.ts:77-79` documents this explicitly.
  A stale session note claimed otherwise; the code disproves it.
- **Finding 7 is narrower than first reported.** The two
  `Record<AutoApprovalReadinessBlockReason, string>` maps are *deliberately*
  different registers — admin renders terse ops labels ("Runtime flag off"),
  owner renders explanatory sentences ("Auto-approval is not enabled for this
  environment."). Both already key off one union, so TypeScript enforces
  exhaustiveness on each. Collapsing them would degrade one surface or the
  other. Only the threshold labels (`Off` / `5★ only` / `4–5★`) are one fact
  spelled twice.

### 1.2 Overview drifted from its own spec

`docs/superpowers/specs/2026-07-30-admin-console-redesign-design.md` §2 lists
Overview and Businesses as separate pages, so finding 2 is **not** an argument
to delete a page. But §5 defines Overview as "health strip plus a 'needs
attention' list deep-linking into the work" — it never called for a paginated
business inventory. The 8-column table now on Overview is drift, and that drift
is what duplicates the Businesses page and brought `.slice()` pagination with
it. Finding 2 is therefore a spec-alignment fix.

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Overview shape | Health + needs-attention + short at-risk list | Spec §5; Businesses becomes the single inventory owner |
| Channel routes | Full unification, both portals | Only option that removes the owner→admin import and makes re-divergence unspellable |
| Fan-out sweep | Unbounded + self-contradicting only | Sequentialising fixed-width write paths buys consistency at a latency cost with no safety gain |
| Delivery | Three PRs by risk | Independently revertable; closes the latent bug even if the refactors slip |
| At-risk ranking | Preserve the TS churn model (option A) | Reimplementing the risk model in SQL would give it two owners |

All of this is UI + Next route work. No worker, webhook, migration, or billing
surface is touched, so it takes the normal PR lane to `main` — no staging ride
required (`CLAUDE.md` → Environments & branches).

## 3. PR 1 — correctness

Five independent fixes, no structural change.

### 3.1 Owner sign-out

`src/components/dashboard/shell/Sidebar.tsx:82` — `/admin/login` → `/login`.

Today an owner signs out, lands on the admin login form
(`allowedRoles={['admin']}`), re-enters their credentials, and is signed
straight back out with "That account is for the owner portal. Use /login
instead." (`useLoginSubmit.ts:113-118`). `src/proxy.ts:267` already routes the
owner flow correctly; this is the client-side path the middleware never sees.

**Scope guard:** the identical `/admin/login` target in
`require-owner-access.ts:60,77` and `(authenticated)/layout.tsx:81,95` is
deliberate and pinned by `require-owner-access.test.ts:137,145`. It is **not**
changed here. The sidebar is the only such path with no test and the only one a
user triggers on purpose.

**New test** `src/components/dashboard/shell/__tests__/Sidebar.test.tsx`:
successful sign-out pushes `/login`; a failed `signOut()` sets the error state
and performs no navigation.

### 3.2 Telegram blank-username fallback

`src/app/api/admin/channels/telegram/start/route.ts:20` — `?? 'RepWorthBot'`
→ `?.trim() || 'RepWorthBot'`, matching the owner route.

`TELEGRAM_BOT_USERNAME` is declared `rawOpt` (`src/lib/config/server.ts:230`),
which by design "preserves `''`/`'   '`/unset byte-for-byte". With `??`, a
set-but-blank value yields `https://t.me/?start=<token>` — a broken QR on the
admin enrolment path, while the owner path recovers. `server.ts:224` documents
both guards side by side without reconciling them.

This lands in PR 1 rather than waiting for PR 2 so the bug closes even if the
unification slips.

**New test:** blank and whitespace-only `TELEGRAM_BOT_USERNAME` both fall back
to `RepWorthBot`.

### 3.3 Business-detail fan-out

`src/app/admin/businesses/[id]/page.tsx:27` — `Promise.all([getBusinessDetail,
getBusinessChannelEnrollments])` → two sequential awaits.

`business-detail/queries.ts:97,214` sequences 13 queries one at a time and says
so twice in the imperative ("do NOT re-introduce a Promise.all"). The page above
it puts two chains in flight anyway. Its comment currently reads "Concurrent,
not serialized", contradicting `costs/page.tsx:23`, `overview/page.tsx:17`, and
`settings/locations/page.tsx:32`. Rewrite the comment to match the siblings.

Since the #773 admission chokepoint landed this queues rather than wedges, so
this is a convention and latency fix, not an outage fix.

### 3.4 Competitors fan-out

`src/app/(authenticated)/settings/competitors/page.tsx:24` —
`Promise.all(locations.map(loadRivalPickerView))` → sequential accumulation.

`loadRivalPickerView` runs three sequential queries of its own
(`named-rival.ts:461,484,495`), so an account with N locations issues N
concurrent chains and 3N queries against a three-connection pool under a
30-second admission deadline. This is the only fan-out whose width grows with
the customer.

### 3.5 Auto-approval threshold labels

New `src/lib/auto-approval/labels.ts` — a pure constants module, no imports
beyond the existing `AutoApprovalReadinessBlockReason` type — owning the
threshold vocabulary (`Off` / `5★ only` / `4–5★`). Imported by both
`(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` and
`admin/businesses/[id]/_components/AutoApprovalDiagnosticsPanel.tsx`.

The two block-reason maps stay where they are, each gaining a comment recording
that the differing registers are intentional (see §1.1).

### 3.6 Out of scope for PR 1

Deliberately **not** sequentialised, each gaining a one-line comment saying why:

- `api/account/settings/route.ts:70` — fixed width 2, read path
- `api/locations/add/route.ts:124` — fixed width 3, write path; sequentialising
  adds latency to a customer-visible write for no safety gain
- `dashboard/add-location/page.tsx:36` — fixed width 2, read path

## 4. PR 2 — channel-route unification

### 4.1 Structure

Move `src/app/api/admin/channels/_shared/` to `src/app/api/_shared/channels/`.
This follows the established convention that a `_shared` folder sits at the
common ancestor of its consumers (`api/zernio/_shared`,
`api/dashboard/past-replies/_shared`); the common ancestor of
`api/admin/channels/*` and `api/dashboard/channels/*` is `src/app/api/`.
Underscore-prefixed folders are excluded from App Router routing.

| Module | Owns |
|---|---|
| `resolve-actor.ts` | `ChannelActor = { businessId, accountId, actorUserId, surface: 'admin' \| 'dashboard' }`; `resolveAdminActor`; `resolveOwnerActor` |
| `start.ts` | `runChannelStart` — token → advisory lock → `startMobileEnrollment` → cache invalidate → QR/deep-link response |
| `action.ts` | `runChannelCancel`, `runChannelDisable` |

All 12 routes (2 portals × 2 channels × 3 actions) become binding shims. The
resolver is the only axis that varies.

- `resolveAdminActor`: `requireAdminWithAal2` → `businessId` from body →
  accounts join → `actorUserId` from the admin gate.
- `resolveOwnerActor`: `requireRoleOr401(req, 'owner')` → `locationId` from
  session, never body → `resolveWritableAccountForLocation`.

`surface` (`'admin' | 'dashboard'`) drives the `disconnectChannel` audit tag and the
`safeInvalidateChannelCache` label, so `admin.telegram.cancel` and
`dashboard.telegram.cancel` remain distinct. The union deliberately reuses
`disconnectChannel`'s existing two values (`src/lib/channels/disable-enrollment.ts:24`)
rather than `'admin' | 'owner'` as first drafted: an `'owner'` value would need a
translation step to `'dashboard'` at every audit and cache-label site, for no
behavioural gain.

`resolveAdminActor` takes a `requireFullAccess` flag, because §4.2's asymmetry is
real: `start` needs the strict `subscriptionGrantsFullAccess` gate and
`cancel`/`disable` must not gain one. It is one query — the accounts join — with
the gate applied only when the caller asks for it. Admin `cancel`/`disable` move
from `SELECT account_id FROM businesses` to that join; this adds no gate and no
second query.

The per-channel flag/env modules move too. `admin/channels/telegram/_shared.ts`
and `admin/channels/whatsapp/_shared.ts` become
`src/lib/notifications/channels/{telegram,whatsapp}-env.ts`, beside the
`flags.ts` they already wrap. Their consumers are not only routes:
`src/app/(authenticated)/settings/channels/page.tsx` and
`src/app/api/dashboard/channels/route.ts` call `whatsappEnvReady()` for UI
availability, so an `api/_shared/` home would leave a *page* importing from an
API route folder. The pass-throughs `isTelegramEnabled()` / `isWhatsAppEnabled()`
are deleted — both are one-line wrappers over `channelsTelegramEnabled()` /
`channelsWhatsappEnabled()`, which those same two files already import directly
for WhatsApp.

Deep-link construction moves to `src/lib/notifications/channels/deep-links.ts` as
one exhaustive `buildMobileDeepLink(channel, rawToken)`, so a builder cannot be
spelled twice.

### 4.2 Subscription policy is preserved, not merged

The two portals have genuinely different billing gates and this refactor does
not unify them:

- admin `start` keeps its strict `subscriptionGrantsFullAccess` check
- admin `cancel`/`disable` keep having no subscription check
- owner keeps `resolveWritableAccountForLocation` on all three

The resolver returns the gate outcome; the runner never second-guesses it.

### 4.3 Behaviour change

Within the owner routes today, the same gate result maps two ways:
`no_account` → `404 not_found` in `start`, but `403 subscription_not_active` in
`cancel` and `disable`. This standardises on **`404 not_found`** — "no account
for this location" is a not-found condition, not a billing one.

This is an owner-visible response-code change on two endpoints and is called out
explicitly rather than absorbed silently.

### 4.4 What this closes structurally

- the owner→admin `_shared` import — **both halves**. The runner import in the 6
  owner routes, and the flag/env import in 8 owner-side sites (those 6 routes,
  `api/dashboard/channels/route.ts`, and `(authenticated)/settings/channels/page.tsx`).
  Moving only the runners, as §4.1 first read, would have left the second half
  live and this claim only half-true.
- the Telegram `??` / `||` deep-link divergence — after PR 1 patches it, PR 2 makes
  it unspellable twice
- a **second, unreported deep-link divergence**: admin `whatsapp/start` stripped
  `/^whatsapp:\+?/` while owner `whatsapp/start` stripped `/\D/g`. A
  `TWILIO_WHATSAPP_NUMBER` carrying spaces, dashes or parens produced a broken
  `wa.me` link on the admin side only. The owner's `/\D/g` form wins.
- the `no_account` 404/403 split
- the error-response header split: admin's 400/403/404 lacked the
  `Cache-Control: no-store, private` that owner's `errorResponse()` always sets.
  Unified on always-no-store.

### 4.5 Testing

- The 6 admin route test files (`{telegram,whatsapp}/__tests__/{start,cancel,disable}.test.ts`)
  are the regression net. They mock only `@/lib/db/server`, `@/lib/db/auth`,
  `@supabase/ssr`, `@/lib/auth/mfa` and `qrcode` — they contain **zero** references
  to the `_shared` paths — so they must pass **byte-for-byte unmodified**, which is
  stronger than "unmodified except for import paths". A gate command asserts this
  with `git diff --quiet`; any edit is a signal the refactor changed admin semantics.

  **As built, that signal fired once and the break was taken deliberately.** Four
  of the six suites seeded the resolver's row as `{ account_id: 'acct-1' }` — the
  projection of the pre-refactor `SELECT account_id FROM businesses` resolver.
  `resolveAdminActor` uses the accounts join this spec authorises above and reads
  `.id`, so those 6 fixture sites yielded `undefined`. Only ONE failed loudly; the
  other five passed **vacuously**, with `undefined` flowing into the advisory-lock
  key and the cache label unobserved — neutering, among others, a guard whose own
  comment reads "Reverting to `business_id` fails here". All 6 sites were updated
  to `{ id: 'acct-1', subscription_status: 'active' }`, matching what the four
  `start` suites already seed. Production is unaffected either way: the join
  predicate is `b.account_id = a.id`, so both projections return the same value
  and only the mock's column name changed. Rationale and approval:
  `docs/superpowers/plans/refactor-channel-route-unification-deviations.md`
  → Task 6 verdict.
- The 2 admin `_shared.test.ts` files are NOT part of that net — they test the
  flag/env modules and move with them to
  `src/lib/notifications/channels/__tests__/{telegram,whatsapp}-env.test.ts`,
  dropping the `isTelegramEnabled` / `isWhatsAppEnabled` cases that
  `src/lib/notifications/channels/__tests__/flags.test.ts` already table-tests.
- There are no existing owner `cancel`/`disable` tests for the `no_account`
  condition, so §4.3's change is covered by **new** tests, not updated ones.
- Backfill the missing `api/dashboard/channels/telegram/cancel` test (WhatsApp
  has one; Telegram does not).
- New unit tests for `resolveAdminActor` and `resolveOwnerActor` covering: auth
  failure, missing/invalid scope, blocked subscription, success.
- New tests for the runner **transaction protocol**, which nothing in the repo
  pins today: the admin start suites push `sqlQueue.push([]) // advisory lock` as
  a comment, never an assertion, and their `begin` shares one queue with the bare
  `sql` calls, so the lock is indistinguishable from any other statement.
  Token-minted-outside-the-tx, the `mobile_enroll:<accountId>` key, and
  lock-before-`startMobileEnrollment` all need pinning before the runners are
  rewritten.
- New tests that the six admin shims BIND the right §4.2 posture. The resolver
  unit tests prove `requireFullAccess` works in isolation; only a route-level
  test proves each shim passes the right value, which is what stops admin
  `cancel` from silently gaining a billing gate. Admin Telegram `start` also has
  no existing inactive-subscription test today (WhatsApp `start` does), so it can
  silently LOSE its gate.

## 5. PR 3 — Overview spec-alignment

### 5.1 The constraint

`computeChurnRiskScore` (`src/lib/shared/churn-score.ts`) is TypeScript, not
SQL: a weighted composite of approval rate (30d), days since approval,
satisfaction pulse, response-time trend, and account age. Because account age
contributes, every business carries a non-zero score, so there is no cheap SQL
predicate that is a provable superset of "at risk". Ranking therefore cannot
become `ORDER BY … LIMIT` without reimplementing the risk model in SQL.

**Decision (option A):** preserve the TS model. Overview loads all business rows
plus metrics, scores in TS, sorts descending by score, and returns only the top
**5**. Two bounded queries returning one row per business; at the ~250 locations
the existing code comments assume, this is trivial.

`5` is a named constant (`OVERVIEW_AT_RISK_LIMIT`) alongside the existing page
sizes in `src/app/admin/page-sizes.ts`, so the server page and its client
component cannot disagree about the list length.

**The list is filtered, then capped — not simply "top 5".** Only businesses
whose `churnScore.level` is not `healthy` are eligible; the top 5 of those by
descending score are shown. An all-healthy account therefore renders the empty
state rather than five healthy businesses under an "At risk" heading. Ties break
on business name ascending so the order is stable across refreshes.

This fixes the duplication and the payload, **not** the underlying "read every
business" query — recorded here so the limitation is not mistaken for an
oversight. The alternative considered and rejected was a SQL-ranked attention
proxy (past-due, reconnect backlog ≥ 3, oldest pending, stale activity), which
is genuinely bounded but drops the churn model from the landing page and would
disagree with the Health column on `/admin/businesses`.

`.slice()` disappears not because pagination improved but because Overview stops
paginating and starts ranking.

### 5.2 Shared query owner

New `src/lib/admin/business-summary.ts` owning:

- the row shape and the base query — `FROM businesses b JOIN accounts a ON a.id
  = b.account_id LEFT JOIN responses resp ON resp.business_id = b.id AND
  resp.status != 'superseded'` with the `pending_approval` count expression
  (today spelled identically in two services)
- the metrics follow-up, scoped to the ids just returned
- `buildBusinessSummary`, relocated from `overview-service.ts`

One exported function taking an optional `{ limit, offset }`: Overview calls it
unpaginated, Businesses calls it with a page. Both paths stay sequential per
#773 — rows query, then metrics query.

`buildBusinessSummary` moves **with its `fallow-ignore-next-line complexity`
comment intact**; `ci:fallow:coverage` is a required check and would otherwise
flag the relocation.

### 5.3 Overview

Health tiles and the needs-attention strip are unchanged. The business table is
replaced by an unpaginated at-risk list of at most `OVERVIEW_AT_RISK_LIMIT` (5)
rows — name, level, score, link to detail — with a "View all →" link to
`/admin/businesses`.

Drops one query: `totalBusinesses` becomes `rows.length`, since the page already
holds every row.

### 5.4 Businesses

Becomes the single inventory owner, absorbing Reconnect, Response rate, Avg
time, Last activity, and Health alongside its existing Category and Last Sync.

Metrics are fetched **for the current page's ids only** — `LIMIT/OFFSET` first,
then metrics for those ids — so this page is bounded where today's Overview
fan-out is not.

### 5.5 Response shapes

- `GET /api/admin/overview` returns `atRisk[]` in place of `businesses[]`
- `GET /api/admin/businesses` gains the metric fields

Both are internal admin APIs with no external consumers. No nav change: spec §2's
two pages both remain, in their existing groups.

### 5.6 Testing

- The existing overview characterization tests follow `buildBusinessSummary`
  into the shared module and must keep passing unmodified.
- New: at-risk selection and ordering — healthy businesses excluded entirely,
  highest score first, ties broken on name, capped at 5, and the empty state
  rendered when every business is healthy.
- New: a test pinning that the Businesses page requests metrics only for its
  page ids, so the bounded-fetch property cannot silently regress.

## 6. Error handling

No new error surfaces. Existing behaviour is preserved throughout:

- `ErrorState` / `EmptyState` continue to serve both admin pages; Overview's
  at-risk list gets the standard `EmptyState` when nothing is at risk.
- Channel routes keep their current failure mapping — `MultipleMobileChannelsError`
  → 409, `EnrollmentDatabaseError` → 500 via `reportCaughtError`, flag/env gates
  short-circuit first — with the single deliberate exception in §4.3.
- The owner sign-out error branch is unchanged: it sets the error state and does
  not navigate, and PR 1 adds the test that pins this.

## 7. Testing gate

Per PR: `pnpm lint && pnpm typecheck && pnpm test`.

No DB-backed suite is required — nothing here touches schema. Note that the
local `pnpm test` run skips 47 files / 330 tests without
`TEST_DATABASE_POOL_URL`, including `dashboard/channels/whatsapp/enroll-e2e.integration.test.ts`,
which covers the PR 2 surface. **That suite must be run explicitly with the test
DB set before PR 2 merges** — an existing-but-not-run suite is how #520 shipped.

## 8. Out of scope

- The `/admin/login` targets in `require-owner-access.ts` and the authenticated
  layout (deliberate, test-pinned — §3.1)
- The three fixed-width fan-outs in §3.6
- Unifying the admin and owner subscription gates (§4.2)
- Any nav or IA change; both admin pages stay per console spec §2
- Owner dashboard, marketing pages, and the auth-page designs
- A lint rule banning `Promise.all` over `sql` in composition roots — revisit
  only if §3.6 is ever swept

## 9. Constraints honored

- **Invariant #1** — no runtime LLM/queue/`postgres` imports added to
  `src/app/**` or `src/components/**`; `src/lib/auto-approval/labels.ts` is a
  pure constants module.
- **Invariant #13** — no `NEXT_PUBLIC_*` companion introduced; flag state stays
  server-authoritative.
- **Invariant #15** — `business-summary.ts` and the channel runners receive
  `sql` as an explicit parameter; only the server pages and route handlers
  import the singleton.
- **#773** — every new or modified DB path keeps at most one query in flight per
  request chain.
- **Repo rules** — no new top-level directories, no new dependencies; `_shared`
  placement follows the existing common-ancestor convention.
